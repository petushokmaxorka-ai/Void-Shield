// ═══════════════════════════════════════════════════════════
// VOID-SHIELD — VPN Manager (orchestration)
// ═══════════════════════════════════════════════════════════
// Оркестрирует: подписка → конфиг → xray-процесс → gRPC → UI.
// НЕ зависит от systemd. Сам управляет жизненным циклом xray.

import { execFile } from 'child_process'
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import * as http from 'http'
import * as https from 'https'
import { app } from 'electron'
import type { ParsedNode } from './subscription'
import {
  parseSubscription,
  parseUserInfoHeader,
  SubscriptionUserInfo,
  isClientWhitelistStub,
  isWhitelistStubError,
  whitelistStubError,
} from './subscription'
import { buildConfig } from './config-builder'
import { buildSingboxConfig, SINGBOX_CLASH_API } from './singbox-config-builder'
import { SingboxRunner } from './singbox-runner'
import * as grpc from './grpc-client'
import * as runner from './xray-runner'
import { checkCaps, grantCapsLinux, platformNeedsCaps } from './capabilities'
import { loadSettings, updateSettings, getSubscriptionUrl, setSubscriptionUrl, Settings, SubscriptionQuota, CoreEngine } from './storage'
import { sortNodesForRoster } from '../shared/node-region.js'
import { applySystemProxy, clearSystemProxy } from './system-proxy'
import { XRAY_HTTP_PORT, XRAY_SOCKS_HOST } from './xray-constants'

// sing-box runner instance (lazy — only used when active core is singbox).
let _singbox: SingboxRunner | null = null
function singbox(): SingboxRunner {
  if (!_singbox) _singbox = new SingboxRunner()
  return _singbox
}

// Which core binary path is active right now.
function activeRunner(): { kind: CoreEngine; path: () => string; configPath: () => string; isRunning: () => boolean; startedTime: () => number } {
  const core = loadSettings().core
  if (core === 'xray') {
    return { kind: 'xray', path: runner.xrayPath, configPath: runner.configPath, isRunning: runner.isRunning, startedTime: runner.startedTime }
  }
  const sb = singbox()
  return { kind: 'singbox', path: () => sb.binaryPath(), configPath: () => sb.configPath(), isRunning: () => sb.isRunning(), startedTime: () => sb.startedTime() }
}

// Egress-IP cache (refreshed at most every 30s).
let _egressIp = ''
let _egressTs = 0
const EGRESS_TTL = 30_000

// Cached parsed nodes (from last subscription update) for fast node listing
// without re-reading the xray config.
function readConfigNodes(): { tag: string; server: string; port: number }[] {
  // Read whichever config belongs to the active core.
  const core = loadSettings().core
  const cfgPath = core === 'singbox' ? singbox().configPath() : runner.configPath()
  if (!existsSync(cfgPath)) return []
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    const out: { tag: string; server: string; port: number }[] = []
    const outs = cfg?.outbounds ?? []
    for (const o of outs) {
      const proto = o?.protocol ?? o?.type  // xray=protocol, sing-box=type
      // xray outbounds use protocol: vless/vmess/trojan/shadowsocks
      const isXrayProto = ['vless', 'vmess', 'trojan', 'shadowsocks'].includes(proto)
      // sing-box outbounds use type: vless/vmess/trojan/shadowsocks/hysteria2/...
      // (and also type: selector/urltest/direct/block — skip those).
      const isSbProto = core === 'singbox' && ['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic', 'wireguard', 'shadowtls'].includes(proto)
      if (!isXrayProto && !isSbProto) continue
      let server = ''
      let port = 0
      if (core === 'singbox') {
        server = o?.server ?? ''
        port = Number(o?.server_port ?? 0)
      } else if (proto === 'shadowsocks') {
        server = o?.settings?.servers?.[0]?.address ?? ''
        port = o?.settings?.servers?.[0]?.port ?? 0
      } else {
        const vnext = (o?.settings?.vnext ?? o?.settings?.servers ?? [{}])[0]
        server = vnext?.address ?? ''
        port = vnext?.port ?? 0
      }
      out.push({ tag: o?.tag ?? '', server, port })
    }
    return out
  } catch {
    return []
  }
}

// ─── Fetch subscription text from URL ───────────────────────
// Providers gate real nodes behind specific User-Agents. We try a
// curated UA list (cached working UA first) and accept the first body
// that parses to ≥1 real node. subscription-userinfo header is captured.

// UA priority: Clash.Meta-family (broadest provider coverage, returns
// modern protocols), then v2rayN/Hiddify/sing-box for those providers.
const UA_CANDIDATES = [
  'clash.meta',
  'mihomo/1.18.0',
  'clash-verge/v2.2.0',
  'ClashforWindows/0.20.39',
  'v2rayN/7.0.0',
  'Hiddify/2.0.5',
  'sing-box/1.10.0',
]

interface FetchOutcome {
  body: string
  userAgent: string
  userInfo?: SubscriptionUserInfo
}

// Cross-platform subscription fetch.
// Prefer system curl (Linux: curl, Windows 10+: curl.exe) with headers in a
// temp file. Fall back to Node https for hosts without curl (still covers
// paste-URL for public users on both OSes).
function curlBin(): string {
  return process.platform === 'win32' ? 'curl.exe' : 'curl'
}

function nodeFetchOnce(url: string, userAgent: string, redirectsLeft = 5): Promise<{ body: string; userInfo?: SubscriptionUserInfo }> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http
    const req = lib.get(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: '*/*',
      },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects'))
          return
        }
        const next = new URL(res.headers.location, url).toString()
        nodeFetchOnce(next, userAgent, redirectsLeft - 1).then(resolve, reject)
        return
      }
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode ?? 0}`))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8')
        if (!body.trim()) return reject(new Error('Empty subscription response'))
        const rawInfo = res.headers['subscription-userinfo']
        const infoStr = Array.isArray(rawInfo) ? rawInfo[0] : rawInfo
        const userInfo = infoStr ? parseUserInfoHeader(infoStr) : undefined
        resolve({ body, userInfo })
      })
    })
    req.on('error', (e) => reject(new Error(`Fetch failed: ${e.message}`)))
    req.on('timeout', () => { req.destroy(); reject(new Error('Fetch failed: timeout')) })
  })
}

function curlOnce(url: string, userAgent: string, direct: boolean): Promise<{ body: string; userInfo?: SubscriptionUserInfo }> {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'void-shield-curl-'))
    const hdrPath = join(dir, 'headers.txt')
    const args = ['-4', '-sS', '--max-time', '20', '-L']
    if (direct) args.push('--noproxy', '*')
    args.push('-A', userAgent, '-D', hdrPath, url)
    execFile(curlBin(), args, { encoding: 'utf-8', timeout: 25000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        try {
          if (err) {
            // ENOENT / missing curl → Node fallback (direct path only; proxy
            // inheritance is curl's job).
            if (direct || (err as NodeJS.ErrnoException).code === 'ENOENT') {
              nodeFetchOnce(url, userAgent).then(resolve, reject)
              return
            }
            return reject(new Error(`Fetch failed: ${err.message}`))
          }
          const body = stdout
          if (!body.trim()) return reject(new Error('Empty subscription response'))
          let headers = ''
          try { headers = readFileSync(hdrPath, 'utf-8') } catch { /* no header dump */ }
          const blocks = headers.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean)
          const lastHeaders = blocks.length ? blocks[blocks.length - 1] : headers
          let userInfo: SubscriptionUserInfo | undefined
          const m = lastHeaders.match(/^subscription-userinfo:\s*(.+)$/im)
          if (m) userInfo = parseUserInfoHeader(m[1])
          resolve({ body, userInfo })
        } finally {
          try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
        }
      })
  })
}

// ─── FlClashX / local Clash YAML cache (same source the dashboard uses) ──
function flclashProfilesDirs(): string[] {
  const home = homedir()
  const dirs = [
    join(home, '.local', 'share', 'FlClashX', 'profiles'),
    join(home, '.local', 'share', 'FlClash', 'profiles'),
  ]
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const roaming = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    dirs.push(
      join(local, 'FlClashX', 'profiles'),
      join(local, 'FlClash', 'profiles'),
      join(roaming, 'FlClashX', 'profiles'),
      join(roaming, 'FlClash', 'profiles'),
      join(local, 'com.follow', 'FlClash', 'profiles'),
    )
  }
  return dirs
}

function flclashPrefsCandidates(): string[] {
  const home = homedir()
  const paths = [
    join(home, '.local', 'share', 'FlClashX', 'shared_preferences.json'),
    join(home, '.local', 'share', 'FlClash', 'shared_preferences.json'),
  ]
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const roaming = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    paths.push(
      join(local, 'FlClashX', 'shared_preferences.json'),
      join(local, 'FlClash', 'shared_preferences.json'),
      join(roaming, 'FlClashX', 'shared_preferences.json'),
      join(roaming, 'FlClash', 'shared_preferences.json'),
    )
  }
  return paths
}

/** User-dropped Clash YAML for Import File / stub fallback (esp. Windows). */
function userImportYamlCandidates(): string[] {
  const home = homedir()
  const names = ['void-shield-nodes.yaml', 'void-shield-118-nodes.yaml', 'import-clash.yaml']
  const roots = [
    join(home, 'Documents'),
    join(home, 'Desktop'),
    join(home, '.config', 'void-shield'),
    join(home, '.config', 'void-shield-desktop'),
  ]
  if (process.platform === 'win32') {
    const userProfile = process.env.USERPROFILE || home
    roots.push(join(userProfile, 'Documents'), join(userProfile, 'Desktop'))
  }
  const out: string[] = []
  for (const root of roots) {
    for (const name of names) out.push(join(root, name))
  }
  return out
}

function latestYamlInDir(dir: string): string | null {
  if (!existsSync(dir)) return null
  const yamls = readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .map((f) => join(dir, f))
  if (!yamls.length) return null
  yamls.sort((a, b) => {
    try { return statSync(b).mtimeMs - statSync(a).mtimeMs } catch { return 0 }
  })
  return yamls[0]
}

/** Latest Clash YAML under FlClashX/FlClash profiles/ by mtime, or null. */
export function latestFlClashProfilePath(): string | null {
  let best: string | null = null
  let bestM = 0
  for (const dir of flclashProfilesDirs()) {
    const p = latestYamlInDir(dir)
    if (!p) continue
    try {
      const m = statSync(p).mtimeMs
      if (m >= bestM) { best = p; bestM = m }
    } catch { /* skip */ }
  }
  return best
}

/** Find FlClash YAML whose profile.url matches (normalized) the given URL. */
export function findFlClashProfileForUrl(url: string): string | null {
  const want = url.trim().replace(/\/+$/, '')
  if (!want) return null
  for (const prefs of flclashPrefsCandidates()) {
    if (!existsSync(prefs)) continue
    try {
      const raw = readFileSync(prefs, 'utf-8')
      const data = JSON.parse(raw) as Record<string, unknown>
      let fc: Record<string, unknown> | null = null
      const flutterConfig = data['flutter.config']
      if (typeof flutterConfig === 'string') fc = JSON.parse(flutterConfig) as Record<string, unknown>
      else if (flutterConfig && typeof flutterConfig === 'object') fc = flutterConfig as Record<string, unknown>
      const profiles = (fc?.profiles as Array<{ id?: string; url?: string }>) || []
      for (const p of profiles) {
        const pu = (p.url || '').trim().replace(/\/+$/, '')
        if (pu && pu === want && p.id) {
          for (const dir of flclashProfilesDirs()) {
            for (const ext of ['.yaml', '.yml']) {
              const path = join(dir, `${p.id}${ext}`)
              if (existsSync(path)) return path
            }
          }
        }
      }
    } catch { /* prefs missing / corrupt */ }
  }
  return null
}

/** Documents/Desktop void-shield-nodes.yaml (Windows Import File workflow). */
export function findUserImportYaml(): string | null {
  for (const p of userImportYamlCandidates()) {
    if (existsSync(p)) return p
  }
  return null
}

// Try UAs in order; accept first body that yields real nodes. If the cached
// working UA exists, try it first (fast path). Custom UA (settings) is first.
// Two passes: (1) DIRECT — for first-run with no VPN; (2) THROUGH PROXY — for
// refreshing a sub when a VPN is already active (provider may block RU IPs).
async function fetchSubscription(url: string): Promise<FetchOutcome> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Subscription URL must start with http:// or https://')
  }
  const settings = loadSettings()
  const cached = settings.workingUserAgent
  const custom = (settings.customUserAgent || '').trim()
  const base = cached ? [cached, ...UA_CANDIDATES.filter((u) => u !== cached)] : [...UA_CANDIDATES]
  const order = custom
    ? [custom, ...base.filter((u) => u !== custom)]
    : base
  const errors: string[] = []
  let sawWhitelistStub = false
  for (const direct of [true, false]) {
    const phase = direct ? 'direct' : 'via-proxy'
    for (const ua of order) {
      let body: string
      let userInfo: SubscriptionUserInfo | undefined
      try {
        ;({ body, userInfo } = await curlOnce(url, ua, direct))
      } catch (e) {
        errors.push(`${ua} (${phase}): ${(e as Error).message}`)
        continue
      }
      const result = parseSubscription(body, { userInfo })
      if (result.nodes.length > 0) {
        if (ua !== cached) updateSettings({ workingUserAgent: ua })
        if (userInfo) {
          updateSettings({
            quota: {
              upload: userInfo.upload,
              download: userInfo.download,
              total: userInfo.total,
              expire: userInfo.expire,
            } as SubscriptionQuota,
          })
        }
        return { body, userAgent: ua, userInfo }
      }
      if (result.error && (isWhitelistStubError(result.error) || isClientWhitelistStub(body))) {
        sawWhitelistStub = true
      }
      errors.push(`${ua} (${phase}): ${result.dropped ? `${result.dropped} fake/placeholder node(s)` : (result.error ?? '0 nodes')}`)
    }
  }
  if (sawWhitelistStub) {
    throw new Error(
      whitelistStubError(0).replace('(0 fake node(s), e.g. ', '(fake nodes, e.g. ') +
      `\nTried ${order.length} UA(s) × 2 (direct + via-proxy).`
    )
  }
  throw new Error(`Subscription unreachable. Tried ${order.length} UA(s) × 2 (direct + via-proxy) = ${order.length * 2} attempts:\n  - ${errors.slice(0, 8).join('\n  - ')}\n\nThe subscription server may be down, OR you need a working VPN first to reach it (try: Import FlClashX / Import File / Clipboard).`)
}

// ═════ EXPORTED CLASS (all methods via IPC) ═════════════════

export class VpnManager {
  // ─── Settings ─────────────────────────────────────────────
  getSettings(): Settings & { subscriptionUrl: string } {
    const s = loadSettings()
    return { ...s, subscriptionUrl: getSubscriptionUrl(s) }
  }

  setCustomUserAgent(ua: string): void {
    updateSettings({ customUserAgent: (ua || '').trim() })
  }

  /** Decrypted subscription URL (empty if file-imported). */
  getSubscriptionUrl(): string {
    return getSubscriptionUrl(loadSettings())
  }

  // ─── Onboarding state (for first-run UI) ──────────────────
  getState(): { hasSubscription: boolean; capsGranted: boolean; needsCaps: boolean } {
    const s = loadSettings()
    const r = activeRunner()
    const runnerOk = r.isRunning()
    let capsGranted = s.capsGranted
    if (platformNeedsCaps() && !runnerOk) {
      // Re-check caps live on the active core's binary if it isn't running.
      try { capsGranted = checkCaps(r.path()).granted } catch { /* core not extracted yet */ }
    }
    return {
      hasSubscription: existsSync(r.configPath()),
      capsGranted,
      needsCaps: platformNeedsCaps(),
    }
  }

  /** Write core config(s) from parsed nodes and optionally keep/set URL. */
  private applyNodes(
    nodes: ParsedNode[],
    opts?: { filter?: (n: ParsedNode) => boolean; subscriptionUrl?: string }
  ): void {
    const s = loadSettings()
    const core = s.core
    const scenario = s.scenario
    const enableTun = s.enableTun === true
    // Windows without TUN: HAPP-style system proxy (browsers use HTTP inbound).
    const setSystemProxy = process.platform === 'win32' && !enableTun
    if (core === 'singbox') {
      const sbConfig = buildSingboxConfig(nodes, {
        filter: opts?.filter,
        scenario,
        enableTun,
        setSystemProxy,
      })
      writeFileSync(singbox().configPath(), JSON.stringify(sbConfig, null, 2))
    } else {
      const xConfig = buildConfig(nodes, { filter: opts?.filter, enableTun })
      writeFileSync(runner.configPath(), JSON.stringify(xConfig, null, 2))
    }
    if (opts?.subscriptionUrl !== undefined) {
      setSubscriptionUrl(opts.subscriptionUrl)
    }
    updateSettings({ lastUpdate: Date.now() })
  }

  /** Ensure http-in exists (upgrade configs written before v1.0.9). */
  private ensureXrayHttpInbound(): void {
    const p = runner.configPath()
    if (!existsSync(p)) return
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf-8')) as {
        inbounds?: Array<Record<string, unknown>>
      }
      const inbounds = cfg.inbounds ?? []
      if (inbounds.some((i) => i.tag === 'http-in')) return
      inbounds.push({
        tag: 'http-in',
        listen: XRAY_SOCKS_HOST,
        port: XRAY_HTTP_PORT,
        protocol: 'http',
        settings: { allowTransparent: false },
        sniffing: { enabled: true, destOverride: ['http', 'tls'] },
      })
      cfg.inbounds = inbounds
      writeFileSync(p, JSON.stringify(cfg, null, 2))
    } catch {
      /* next import rebuilds */
    }
  }

  /** After xray start on Windows: WinINET → http-in (like HAPP without TUN). */
  private applyTrafficCapture(enableTun: boolean): void {
    if (process.platform === 'win32' && !enableTun) {
      applySystemProxy(XRAY_SOCKS_HOST, XRAY_HTTP_PORT)
    }
  }

  private releaseTrafficCapture(): void {
    clearSystemProxy()
  }

  /** Strip TUN inbound from an already-written xray config (SOCKS fallback). */
  private stripTunFromXrayConfig(): boolean {
    const p = runner.configPath()
    if (!existsSync(p)) return false
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf-8')) as {
        inbounds?: Array<{ tag?: string }>
      }
      const before = cfg.inbounds?.length ?? 0
      cfg.inbounds = (cfg.inbounds ?? []).filter((i) => i.tag !== 'tun-in')
      if ((cfg.inbounds?.length ?? 0) === before) return false
      writeFileSync(p, JSON.stringify(cfg, null, 2))
      return true
    } catch {
      return false
    }
  }

  // ─── Update subscription (download → parse → build config) ─
  async updateSubscription(url: string, opts?: { filter?: (n: ParsedNode) => boolean }): Promise<{ nodes: number; format: string; source?: string }> {
    let body: string | null = null
    let userInfo: SubscriptionUserInfo | undefined
    let source = 'url'
    let fetchError: Error | null = null
    try {
      const fetched = await fetchSubscription(url)
      body = fetched.body
      userInfo = fetched.userInfo
    } catch (e) {
      fetchError = e as Error
    }

    if (body) {
      const result = parseSubscription(body, { userInfo })
      if (result.nodes.length) {
        this.applyNodes(result.nodes, { filter: opts?.filter, subscriptionUrl: url })
        return { nodes: result.nodes.length, format: result.format, source }
      }
      // Live body had no real nodes (stub) — fall through to FlClashX.
      if (!fetchError) {
        fetchError = new Error(result.error ?? 'No nodes parsed from subscription')
      }
    }

    // Dashboard-compatible fallback: FlClash cache, then Documents/Desktop YAML (Windows).
    const matched = findFlClashProfileForUrl(url)
    const stub = !!(fetchError && isWhitelistStubError(fetchError.message))
    const flPath = matched || (stub ? latestFlClashProfilePath() : null)
    const localPath = flPath || (stub ? findUserImportYaml() : null)
    if (localPath) {
      const local = parseSubscription(readFileSync(localPath, 'utf-8'))
      if (local.nodes.length) {
        this.applyNodes(local.nodes, { filter: opts?.filter, subscriptionUrl: url })
        const source = flPath ? 'flclash-cache' : 'local-yaml'
        return { nodes: local.nodes.length, format: local.format, source }
      }
    }

    throw fetchError ?? new Error('No nodes parsed from subscription')
  }

  /** Import latest (or URL-matched) FlClashX profile — same data the dashboard rebuilds from. */
  async importFromFlClashX(preferredUrl?: string): Promise<{ ok: boolean; nodes?: number; format?: string; error?: string; path?: string; source?: string }> {
    const path =
      (preferredUrl ? findFlClashProfileForUrl(preferredUrl) : null) ||
      latestFlClashProfilePath()
    if (!path) {
      return {
        ok: false,
        error: process.platform === 'win32'
          ? 'No FlClash profiles found. On Windows use IMPORT FILE with Documents\\void-shield-nodes.yaml'
          : 'No FlClashX profiles found in ~/.local/share/FlClashX/profiles',
      }
    }
    try {
      const text = readFileSync(path, 'utf-8')
      const result = parseSubscription(text)
      if (!result.nodes.length) {
        return { ok: false, error: result.error ?? 'No nodes in FlClashX profile', path }
      }
      // Keep URL if prefs know it for this file, else clear (manual import).
      let url = preferredUrl?.trim() || ''
      if (!url) {
        try {
          const id = path.replace(/\.(ya?ml)$/i, '').split(/[/\\]/).pop() || ''
          for (const prefs of flclashPrefsCandidates()) {
            if (!existsSync(prefs)) continue
            const raw = readFileSync(prefs, 'utf-8')
            const data = JSON.parse(raw) as Record<string, unknown>
            let fc: Record<string, unknown> | null = null
            const flutterConfig = data['flutter.config']
            if (typeof flutterConfig === 'string') fc = JSON.parse(flutterConfig) as Record<string, unknown>
            else if (flutterConfig && typeof flutterConfig === 'object') fc = flutterConfig as Record<string, unknown>
            const profiles = (fc?.profiles as Array<{ id?: string; url?: string }>) || []
            const hit = profiles.find((p) => p.id === id)
            if (hit?.url) { url = hit.url; break }
          }
        } catch { /* ignore */ }
      }
      this.applyNodes(result.nodes, { subscriptionUrl: url })
      return { ok: true, nodes: result.nodes.length, format: result.format, path, source: 'flclash-cache' }
    } catch (e) {
      return { ok: false, error: (e as Error).message, path }
    }
  }

  // ─── Core switcher ─────────────────────────────────────────
  // Switch active proxy core (sing-box default; xray for edge-case configs).
  // Stops the current core if running, persists the choice, does NOT restart
  // (caller restarts explicitly so the switch is atomic from the user's POV).
  async switchCore(core: CoreEngine): Promise<void> {
    const current = loadSettings().core
    if (current === core) return
    if (activeRunner().isRunning()) {
      await this.stop()
    }
    updateSettings({ core })
    // Ensure the new core's config exists (re-build from last parsed nodes
    // if we have a subscription URL; otherwise the user must re-subscribe).
    // The config file persists across switches, so this is usually a no-op.
  }

  getCore(): CoreEngine {
    return loadSettings().core
  }

  // ─── Routing scenario ─────────────────────────────────────
  // Persist choice + rebuild active-core config + restart so rule-sets apply.
  async switchScenario(scenario: string): Promise<void> {
    updateSettings({ scenario: scenario as Settings['scenario'] })
    // Rebuild config from the last parsed subscription (if any) so the new
    // scenario's rule-sets are baked in. Requires a stored subscription URL.
    const s = loadSettings()
    if (getSubscriptionUrl(s)) {
      await this.updateSubscription(getSubscriptionUrl(s))
      // Restart the active core to load the rebuilt config.
      if (activeRunner().isRunning()) {
        await this.restart()
      }
    }
  }

  getScenario(): string {
    return loadSettings().scenario
  }

  // ─── Subscription quota (subscription-userinfo) ───────────
  getQuota(): SubscriptionQuota | null {
    return loadSettings().quota
  }

  // ─── Batch delay test (sing-box urltest refresh via clash-api) ──
  // Returns tag→ms. xray fallback returns {} (no clash-api there).
  async testDelays(): Promise<Record<string, number>> {
    if (activeRunner().kind !== 'singbox') return {}
    return singbox().testAllDelays()
  }

  // ─── Clipboard / manual share-link import ─────────────────
  // Accepts either a subscription URL (http(s)://) or a raw share-link /
  // base64 blob / Clash YAML and registers it as the subscription source.
  // Used by the "import from clipboard" flow (Phase 3.4).
  async importFromText(text: string): Promise<{ ok: boolean; nodes?: number; format?: string; error?: string }> {
    const trimmed = (text ?? '').trim()
    if (!trimmed) return { ok: false, error: 'Empty input' }
    // Case 1: it's a subscription URL → fetch + parse via existing path.
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const r = await this.updateSubscription(trimmed)
        return { ok: true, nodes: r.nodes, format: r.format }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
    // Case 2: raw payload (share-link / base64 / Clash YAML).
    const result = parseSubscription(trimmed)
    if (!result.nodes.length) {
      return { ok: false, error: result.error ?? 'No nodes parsed' }
    }
    this.applyNodes(result.nodes, { subscriptionUrl: '' })
    return { ok: true, nodes: result.nodes.length, format: result.format }
  }

  // Sniff the system clipboard for a share-link / subscription URL.
  // Called by the renderer on focus to offer one-click import. Returns the
  // detected text or empty string. (Electron clipboard read is cheap + local.)
  checkClipboardForLink(): string {
    try {
      // Lazy import — electron clipboard API.
      const { clipboard } = require('electron')
      const text = (clipboard.readText() ?? '').trim()
      if (!text) return ''
      // Detect: subscription URL, or any share-link scheme, or base64 blob.
      if (/^https?:\/\//i.test(text)) return text
      if (/^(vless|vmess|trojan|ss|hysteria2|hy2|tuic|wireguard):\/\//.test(text)) return text
      // base64 blob (decode-test cheap): only if it's a single short line.
      if (/^[A-Za-z0-9+/=\s]+$/.test(text) && text.replace(/\s/g, '').length > 40 && text.length < 50000) {
        try {
          const dec = Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf-8')
          if (/vless:\/\/|vmess:\/\/|trojan:\/\/|ss:\/\//.test(dec)) return text
        } catch { /* not base64 */ }
      }
      return ''
    } catch {
      return ''
    }
  }

  // ─── Grant TUN capabilities (Linux, one-time via pkexec) ──
  // Returns true on success. Throws on user-cancel / pkexec error.
  grantCapabilities(): boolean {
    // Grant caps to BOTH core binaries (user may switch cores later).
    runner.ensureXrayExtracted()
    try { singbox().ensureExtracted() } catch { /* sing-box may not be bundled on all builds */ }
    if (process.platform === 'linux') {
      let ok = grantCapsLinux(runner.xrayPath())
      try { ok = grantCapsLinux(singbox().binaryPath()) && ok } catch { /* ignore */ }
      if (ok) {
        // After setcap, prefer system-wide TUN on next config rebuild.
        updateSettings({ capsGranted: true, enableTun: true })
      }
      return ok
    }
    // macOS/Windows: no setcap flow; mark granted (see capabilities.ts notes).
    // Keep enableTun false — SOCKS ignition works without admin; TUN needs elevation.
    updateSettings({ capsGranted: true })
    return true
  }

  // ─── Start VPN (SOCKS + system proxy on Windows; TUN optional) ──
  async start(): Promise<void> {
    const s = loadSettings()
    const r = activeRunner()
    r.kind === 'xray' ? runner.ensureXrayExtracted() : singbox().ensureExtracted()
    if (r.kind === 'xray') this.ensureXrayHttpInbound()
    // Caps only required when TUN mode is enabled.
    if (s.enableTun && platformNeedsCaps()) {
      const capState = checkCaps(r.path())
      if (capState.needsElevation && !s.capsGranted) {
        throw new Error('TUN capabilities not granted. Call grantCapabilities() first.')
      }
    }
    const runCore = async (): Promise<void> => {
      if (r.kind === 'xray') await runner.start()
      else await singbox().start()
    }
    try {
      await runCore()
    } catch (e) {
      const msg = (e as Error).message || ''
      // Auto-fallback: old configs always had TUN; Windows without admin exits immediately.
      if (r.kind === 'xray' && /did not stay running/i.test(msg)) {
        const stripped = this.stripTunFromXrayConfig()
        if (stripped || s.enableTun) {
          updateSettings({ enableTun: false })
          await runCore()
          this.applyTrafficCapture(false)
          return
        }
      }
      throw e
    }
    this.applyTrafficCapture(s.enableTun === true)
  }

  async stop(): Promise<void> {
    this.releaseTrafficCapture()
    const r = activeRunner()
    if (r.kind === 'xray') await runner.stop()
    else await singbox().stop()
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  isRunning(): boolean {
    return activeRunner().isRunning()
  }

  // ─── Status (for dashboard polling) ───────────────────────
  async getStatus(): Promise<{
    running: boolean
    uptime: number
    egressIp: string
    activeNode: string
    override: string
    autoMode: boolean
    apiOk: boolean
    socksOk: boolean
    tunOk: boolean
  }> {
    const r = activeRunner()
    const running = r.isRunning()
    let activeNode = ''
    let override = ''
    let apiOk = false
    let socksOk = false
    let tunOk = false
    if (running) {
      try {
        if (r.kind === 'singbox') {
          const sb = singbox()
          const { selector, urltest } = await sb.getActiveNode()
          activeNode = selector || urltest
          override = selector && selector !== urltest ? selector : ''
          apiOk = Boolean(urltest || selector)
          socksOk = apiOk
          tunOk = false // sing-box TUN probe: clash-api only today
        } else {
          const bi = await grpc.getBalancerInfo()
          activeNode = bi.activeNode || bi.override
          if (!activeNode) {
            activeNode = await grpc.inferActiveNodeFromObservatory()
          }
          override = bi.override
          apiOk = bi.ok
          socksOk = await runner.socksOk()
          tunOk = await runner.tunOk()
        }
      } catch { /* core not ready yet */ }
    }
    let egress = ''
    if (running) {
      const stale = !_egressIp || Date.now() - _egressTs > EGRESS_TTL
      if (stale) {
        try {
          const ip = await runner.probeEgress()
          if (ip) {
            _egressIp = ip
            _egressTs = Date.now()
          }
        } catch { /* probe failed */ }
      }
      egress = _egressIp
    } else {
      _egressIp = ''
      _egressTs = 0
    }
    return {
      running,
      uptime: running ? Math.floor((Date.now() - r.startedTime()) / 1000) : 0,
      egressIp: egress,
      activeNode,
      override,
      autoMode: override === '',
      apiOk,
      socksOk,
      tunOk,
    }
  }

  // ─── Node list (config + observatory / clash-api) ─────────
  async getNodes(): Promise<{
    nodes: { tag: string; server: string; port: number; alive: boolean | null; delayMs: number | null; lastError: string }[]
    total: number
    alive: number
  }> {
    const r = activeRunner()
    const staticNodes = readConfigNodes()
    const byTag = new Map(staticNodes.map((n) => [n.tag, n]))
    const result: { tag: string; server: string; port: number; alive: boolean | null; delayMs: number | null; lastError: string }[] = []
    let aliveCount = 0
    if (r.isRunning()) {
      try {
        if (r.kind === 'singbox') {
          const delays = await singbox().testAllDelays()
          for (const [tag, ms] of Object.entries(delays)) {
            const meta = byTag.get(tag) ?? { server: '', port: 0 }
            const alive = ms > 0
            result.push({ tag, server: meta.server, port: meta.port, alive, delayMs: alive ? ms : null, lastError: alive ? '' : 'timeout' })
            if (alive) aliveCount++
          }
        } else {
          const obs = await grpc.getOutboundStatus()
          for (const s of obs.status ?? []) {
            const meta = byTag.get(s.outbound_tag) ?? { server: '', port: 0 }
            result.push({
              tag: s.outbound_tag,
              server: meta.server,
              port: meta.port,
              alive: Boolean(s.alive),
              delayMs: s.alive ? Number(s.delay) : null,
              lastError: s.last_error_reason ?? '',
            })
            if (s.alive) aliveCount++
          }
        }
      } catch { /* core API unavailable */ }
    }
    // Append unprobed static nodes.
    for (const [tag, meta] of byTag) {
      if (!result.some((x) => x.tag === tag)) {
        result.push({ tag, server: meta.server, port: meta.port, alive: null, delayMs: null, lastError: 'not probed' })
      }
    }
    const sorted = sortNodesForRoster(result)
    return { nodes: sorted, total: sorted.length, alive: aliveCount }
  }

  // ─── Node selection ───────────────────────────────────────
  async selectNode(tag: string): Promise<void> {
    if (activeRunner().kind === 'singbox') {
      await singbox().selectNode(tag)
    } else {
      await grpc.overrideBalancerTarget(tag)
    }
  }

  async autoSelect(): Promise<void> {
    if (activeRunner().kind === 'singbox') {
      await singbox().selectNode('')  // empty ⇒ revert to urltest
    } else {
      await grpc.overrideBalancerTarget('')
    }
  }

  // ─── Traffic + logs ───────────────────────────────────────
  async getTraffic(): Promise<{ inboundUp: number; inboundDown: number; uptime: number; goroutines: number; allocBytes: number; error?: string }> {
    const out: { inboundUp: number; inboundDown: number; uptime: number; goroutines: number; allocBytes: number; error?: string } = { inboundUp: 0, inboundDown: 0, uptime: 0, goroutines: 0, allocBytes: 0 }
    const r = activeRunner()
    try {
      if (r.kind === 'singbox') {
        // sing-box clash-api: cumulative counters via /connections totals.
        const j = await fetch(`http://${SINGBOX_CLASH_API}/connections`, { signal: AbortSignal.timeout(2000) }).then((x) => x.json()) as { uploadTotal?: number; downloadTotal?: number }
        out.inboundUp = Number(j.uploadTotal ?? 0)
        out.inboundDown = Number(j.downloadTotal ?? 0)
        out.uptime = r.isRunning() ? Math.floor((Date.now() - r.startedTime()) / 1000) : 0
      } else {
        const { stats, sys } = await grpc.queryStats()
        for (const s of stats) {
          const parts = s.name.split('>>>')
          if (parts.length >= 4 && parts[0] === 'inbound' && parts[1] === 'mixed-in') {
            if (parts[3] === 'uplink') out.inboundUp += Number(s.value)
            if (parts[3] === 'downlink') out.inboundDown += Number(s.value)
          }
        }
        if (sys) {
          out.uptime = Number(sys.Uptime ?? sys.uptime ?? 0)
          out.goroutines = Number(sys.NumGoroutine ?? sys.num_goroutine ?? 0)
          out.allocBytes = Number(sys.Alloc ?? sys.alloc ?? 0)
        }
      }
    } catch (e) {
      out.error = (e as Error).message.slice(0, 80)
    }
    return out
  }

  async getLogs(lines = 200): Promise<string[]> {
    const r = activeRunner()
    if (r.kind === 'singbox') return singbox().tailLog(lines)
    return runner.tailLog(lines)
  }

  // ─── Cleanup ──────────────────────────────────────────────
  async close(): Promise<void> {
    await this.stop()
    // Also stop the inactive core in case it was left running across a switch.
    try { if (_singbox?.isRunning()) await _singbox.stop() } catch { /* ignore */ }
    try { if (runner.isRunning()) await runner.stop() } catch { /* ignore */ }
    grpc.closeGrpc()
  }
}
