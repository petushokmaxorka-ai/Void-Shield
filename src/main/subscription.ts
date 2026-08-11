// ═══════════════════════════════════════════════════════════
// VOID-SHIELD — Subscription Parser (multi-protocol)
// ═══════════════════════════════════════════════════════════
// Принимает сырой текст подписки (что вернул URL) и нормализует
// в массив нод. Поддерживаемые форматы:
//   1. Clash / Clash.Meta YAML (proxies: [...] — любой тип)
//   2. Base64 — список share-ссылок (vless/vmess/trojan/ss)
//   3. Plain text — те же ссылки без base64-обёртки
//
// Поддерживаемые протоколы: vless (+ reality), vmess, trojan,
// shadowsocks (sip002 + legacy JSON). Транспорты: tcp, ws, grpc,
// xhttp (splithttp), httpupgrade, h2, quic.
//
// Выходной формат (ParsedNode) совместим с config-builder.ts.

import * as yaml from 'js-yaml'

// ─── Normalized node shape (consumed by config-builder) ─────
export type Protocol = 'vless' | 'vmess' | 'trojan' | 'shadowsocks' | 'hysteria2' | 'tuic' | 'wireguard' | 'shadowtls'
export type Transport = 'tcp' | 'raw' | 'ws' | 'grpc' | 'xhttp' | 'splithttp' | 'httpupgrade' | 'h2' | 'http' | 'quic' | 'none'

export interface RealityOpts {
  publicKey: string
  shortId: string
  serverName: string
  fingerprint: string
  spiderX?: string
}

export interface TlsOpts {
  enabled: boolean
  serverName?: string
  insecure?: boolean
  alpn?: string[]
  fingerprint?: string  // uTLS (chrome/firefox/safari/edge/random)
  reality?: RealityOpts
}

// Transport-specific settings (mirrors xray streamSettings sub-objects).
export interface TransportOpts {
  type: Transport
  // ws / xhttp / httpupgrade
  path?: string
  host?: string
  headers?: Record<string, string>
  maxEarlyData?: number
  earlyDataHeaderName?: string
  // grpc / xhttp
  serviceName?: string
  mode?: string            // grpc multi/manual; xhttp auto/packet-up/stream-up
  // h2
  h2Hosts?: string[]
  // quic / mkcp
  quicSecurity?: string
  quicKey?: string
}

export interface ParsedNode {
  tag: string
  protocol: Protocol
  server: string
  port: number
  // auth — keyed by protocol:
  //   vless/vmess → uuid; trojan/shadowsocks → password;
  //   hysteria2   → auth password (string); tuic → uuid;
  //   shadowtls   → password; wireguard → (unused, keys in wireguard block)
  auth: string
  // vless only:
  flow?: string
  // shadowsocks only:
  cipher?: string
  // vmess only:
  alterId?: number
  network: Transport
  tls: TlsOpts
  transport: TransportOpts
  udp?: boolean
  // ── QUIC-based protocols (sing-box only) ──
  // hysteria2
  upMbps?: number             // bandwidth up (hysteria2 obfs)
  downMbps?: number           // bandwidth down
  obfs?: string               // hysteria2 obfs password (salamander)
  // tuic
  congestionControl?: string  // bbr / new_reno / cubic
  udpRelayMode?: string       // native / quic
  // wireguard
  wireguard?: {
    localAddress: string[]    // ["10.0.0.2/32"]
    privateKey: string
    peerPublicKey: string
    preSharedKey?: string
    mtu?: number
    reserved?: [number, number, number]
  }
  // shadowtls (wraps another protocol — usually trojan/vless over the shadowtls stream)
  shadowtlsVersion?: number   // 2 | 3
}

export interface SubscriptionUserInfo {
  upload: number
  download: number
  total: number        // 0 = unlimited
  expire: number       // 0 = never; unix seconds
}

export interface ParseResult {
  nodes: ParsedNode[]
  format: 'clash-yaml' | 'share-links' | 'unknown'
  /** Parsed from subscription-userinfo header (caller injects) or body comment. */
  userInfo?: SubscriptionUserInfo
  error?: string
  /** Number of candidate nodes dropped by anti-fake filter. */
  dropped?: number
}

// ─── Anti-fake detection ────────────────────────────────────
// Провайдеры, не желая отдавать конфиг напрямую, подсовывают
// ноды-заглушки: 0.0.0.0:1, security=none, имена «Установите наше
// приложение». Такие ноды никогда не подключаются — дропаем их,
// чтобы UI не показывал «3 ноды активны».
function isFakeNode(n: { server: string; port: number; tag: string; protocol: Protocol }): boolean {
  // 0.0.0.0 / пустой хост + порт 0/1 → маркетинговая заглушка.
  if (!n.server || n.server === '0.0.0.0' || n.server === '::') return true
  if (n.port === 0 || n.port === 1) return true
  const lower = n.tag.toLowerCase()
  // Имена-маркеры заглушек (RU/EN): «установите», «не поддерживается», «demo».
  if (/не поддерживается|установите|не работает|demo|placeholder|stub|unsupported/.test(lower)) {
    // смягчение: только если при этом и сервер фейковый — иначе это может быть реальное имя
    if (n.server === '0.0.0.0' || n.port === 1) return true
  }
  return false
}

/** Remnawave / HAPP-style whitelist stub body (marketing nodes only). */
export function isClientWhitelistStub(text: string): boolean {
  return /установите\s*happ|\bhapp\b|не поддерживается|приложение не поддерживается|для использования сервиса|install\s*happ|unsupported\s*app/i.test(text)
}

export function whitelistStubError(dropped: number): string {
  return (
    `Provider returned a client-whitelist stub (${dropped} fake node(s), e.g. "Install HAPP" / 0.0.0.0:1). ` +
    `This panel only serves approved apps over the subscription URL. ` +
    `Use Import FlClashX, Import File, or set a Custom User-Agent if the panel allows another client.`
  )
}

/** True when an error message is the whitelist-stub case (not a network failure). */
export function isWhitelistStubError(message: string): boolean {
  return /client-whitelist stub|Install HAPP|requires its own app|fake\/placeholder/i.test(message)
}

// ─── Detect format ──────────────────────────────────────────
function looksLikeYaml(text: string): boolean {
  return /^\s*(proxies|proxy-groups|mixed-port|socks-port|port|rules)\s*:/m.test(text)
}

function decodeIfBase64(text: string): string {
  const trimmed = text.trim()
  const linkRe = /^vless:\/\/|^vmess:\/\/|^trojan:\/\/|^ss:\/\/|^hysteria2:\/\/|^hy2:\/\/|^tuic:\/\/|^wireguard:\/\//m
  if (linkRe.test(trimmed)) return trimmed
  // Pure base64 blob: decodes to share links.
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.replace(/\s/g, '').length > 40) {
    try {
      const decoded = Buffer.from(trimmed.replace(/\s/g, ''), 'base64').toString('utf-8')
      if (linkRe.test(decoded)) return decoded
    } catch { /* fall through */ }
  }
  return trimmed
}

// ─── Clash YAML parser ──────────────────────────────────────
function tlsFromClashProxy(p: Record<string, unknown>): TlsOpts {
  const tls = Boolean(p.tls)
  const reality = p['reality-opts'] as Record<string, string> | undefined
  const sni = String(p.servername ?? p.sni ?? '')
  const fp = String(p['client-fingerprint'] ?? p.fp ?? '')
  const insecure = Boolean(p['skip-cert-verify'])
  const alpn = Array.isArray(p.alpn) ? (p.alpn as string[]) : undefined
  return {
    enabled: tls || Boolean(reality),
    serverName: sni || undefined,
    insecure: insecure || undefined,
    alpn,
    fingerprint: fp || undefined,
    reality: reality ? {
      publicKey: String(reality['public-key'] ?? ''),
      shortId: String(reality['short-id'] ?? ''),
      serverName: sni,
      fingerprint: fp || 'chrome',
    } : undefined,
  }
}

function transportFromClashProxy(p: Record<string, unknown>): TransportOpts {
  const net = String(p.network ?? 'tcp')
  const t: TransportOpts = { type: 'tcp' }
  switch (net) {
    case 'ws': {
      t.type = 'ws'
      const o = (p['ws-opts'] ?? {}) as Record<string, unknown>
      t.path = String(o.path ?? '/')
      const headers = (o.headers ?? {}) as Record<string, string>
      t.host = headers.Host ?? String(o.host ?? '')
      if (headers.Host) { delete headers.Host; t.headers = headers }
      else if (Object.keys(headers).length) t.headers = headers
      if (o['max-early-data'] != null) {
        t.maxEarlyData = Number(o['max-early-data'])
        t.earlyDataHeaderName = String(o['early-data-header-name'] ?? 'Sec-WebSocket-Protocol')
      }
      break
    }
    case 'grpc': {
      t.type = 'grpc'
      const o = (p['grpc-opts'] ?? {}) as Record<string, unknown>
      t.serviceName = String(o['grpc-service-name'] ?? '')
      t.mode = String(o.multiMode ? 'multi' : 'gun')
      break
    }
    case 'h2':
    case 'http': {
      t.type = 'h2'
      const o = (p['h2-opts'] ?? {}) as Record<string, unknown>
      t.path = String(o.path ?? '/')
      t.h2Hosts = Array.isArray(o.host) ? (o.host as string[]) : (o.host ? [String(o.host)] : [])
      break
    }
    default:
      t.type = 'tcp'
  }
  return t
}

function parseClashYaml(text: string): { nodes: ParsedNode[]; dropped: number } {
  const doc = yaml.load(text) as Record<string, unknown>
  const proxies = (doc?.proxies as Record<string, unknown>[]) ?? []
  const nodes: ParsedNode[] = []
  let dropped = 0
  for (const p of proxies) {
    const type = String(p.type ?? '').toLowerCase()
    const candidate: Partial<ParsedNode> = {
      tag: String(p.name ?? `${p.server}:${p.port}`),
      server: String(p.server ?? ''),
      port: Number(p.port ?? 0),
      network: 'tcp',
      tls: tlsFromClashProxy(p),
      transport: transportFromClashProxy(p),
      udp: p.udp !== false,
    }
    candidate.network = candidate.transport!.type
    if (type === 'vless') {
      candidate.protocol = 'vless'
      candidate.auth = String(p.uuid ?? '')
      candidate.flow = String(p.flow ?? '')
    } else if (type === 'vmess') {
      candidate.protocol = 'vmess'
      candidate.auth = String(p.uuid ?? '')
      candidate.alterId = Number(p.alterId ?? p['alter-id'] ?? 0)
      candidate.cipher = String(p.cipher ?? 'auto')
    } else if (type === 'trojan') {
      candidate.protocol = 'trojan'
      candidate.auth = String(p.password ?? '')
    } else if (type === 'ss' || type === 'shadowsocks') {
      candidate.protocol = 'shadowsocks'
      candidate.auth = String(p.password ?? '')
      candidate.cipher = String(p.cipher ?? '')
    } else if (type === 'hysteria2' || type === 'hy2') {
      candidate.protocol = 'hysteria2'
      candidate.auth = String(p.password ?? '')
      candidate.network = 'quic'
      candidate.transport = { type: 'quic' }
      const up = p.up ?? p['up-mbps']; if (up != null) candidate.upMbps = Number(up)
      const down = p.down ?? p['down-mbps']; if (down != null) candidate.downMbps = Number(down)
      const obfs = p['obfs']; const obfsPw = p['obfs-password']
      if (obfs === 'salamander' && obfsPw) candidate.obfs = String(obfsPw)
      // Hysteria2 always TLS; re-derive with alpn default h3.
      candidate.tls = { enabled: true, serverName: String(p.sni ?? '') || undefined, alpn: Array.isArray(p.alpn) ? (p.alpn as string[]) : ['h3'], insecure: Boolean(p['skip-cert-verify']) || undefined }
    } else if (type === 'tuic') {
      candidate.protocol = 'tuic'
      candidate.auth = String(p.uuid ?? '')
      candidate.network = 'quic'
      candidate.transport = { type: 'quic' }
      candidate.cipher = String(p.password ?? '')  // TUIC v5 password
      candidate.congestionControl = String(p['congestion-controller'] ?? 'bbr')
      candidate.udpRelayMode = String(p['udp-relay-mode'] ?? 'native')
      candidate.tls = { enabled: true, serverName: String(p.sni ?? '') || undefined, alpn: Array.isArray(p.alpn) ? (p.alpn as string[]) : ['h3'], insecure: Boolean(p['skip-cert-verify']) || undefined }
    } else if (type === 'wireguard' || type === 'wg') {
      candidate.protocol = 'wireguard'
      candidate.network = 'none'
      candidate.transport = { type: 'none' }
      candidate.tls = { enabled: false }
      // WireGuard peer/local keys (mihomo naming).
      const peers = (p.peers ?? [{}]) as Record<string, unknown>[]
      const peer = peers[0] ?? {}
      candidate.wireguard = {
        localAddress: Array.isArray(p.ip) ? (p.ip as string[]) : (p.ip ? [String(p.ip)] : []),
        privateKey: String(p['private-key'] ?? p.private ?? ''),
        peerPublicKey: String(peer['public-key'] ?? peer.public ?? ''),
        preSharedKey: String(peer['pre-shared-key'] ?? '') || undefined,
        mtu: Number(p.mtu ?? 1280),
        reserved: Array.isArray(p.reserved) ? (p.reserved as [number, number, number]) : undefined,
      }
      // server/port come from peer if present (mihomo style).
      if (peer.server) candidate.server = String(peer.server)
      if (peer.port) candidate.port = Number(peer.port)
    } else {
      continue // unsupported type (ssh, naive, anytls — beyond Phase 2 scope)
    }
    const node = candidate as ParsedNode
    if (isFakeNode(node)) { dropped++; continue }
    nodes.push(node)
  }
  return { nodes, dropped }
}

// ─── Share-link parsers ─────────────────────────────────────
function safeDecode(s: string | null | undefined): string {
  if (!s) return ''
  try { return decodeURIComponent(s) } catch { return String(s) }
}

function parseTlsFromQuery(params: URLSearchParams, protocol: Protocol): TlsOpts {
  const security = params.get('security') ?? (protocol === 'trojan' ? 'tls' : 'none')
  const tls: TlsOpts = {
    enabled: security === 'tls' || security === 'reality',
    serverName: params.get('sni') ?? params.get('peer') ?? undefined,
    insecure: params.get('allowInsecure') === '1' || params.get('insecure') === '1' ? true : undefined,
    alpn: params.get('alpn') ? params.get('alpn')!.split(',') : undefined,
    fingerprint: params.get('fp') ?? undefined,
  }
  if (security === 'reality') {
    tls.reality = {
      publicKey: params.get('pbk') ?? '',
      shortId: params.get('sid') ?? '',
      serverName: params.get('sni') ?? '',
      fingerprint: params.get('fp') ?? 'chrome',
      spiderX: params.get('spx') ?? undefined,
    }
  }
  return tls
}

function parseTransportFromQuery(params: URLSearchParams): TransportOpts {
  const type = (params.get('type') ?? 'tcp') as Transport
  const t: TransportOpts = { type }
  switch (type) {
    case 'ws':
      t.path = safeDecode(params.get('path')) || '/'
      t.host = safeDecode(params.get('host')) || ''
      if (params.get('ed')) {
        t.maxEarlyData = Number(params.get('ed'))
        t.earlyDataHeaderName = 'Sec-WebSocket-Protocol'
      }
      break
    case 'grpc':
      t.serviceName = safeDecode(params.get('serviceName')) || ''
      t.mode = params.get('mode') ?? 'gun'
      break
    case 'xhttp':
    case 'splithttp':
      t.type = 'xhttp'
      t.path = safeDecode(params.get('path')) || '/'
      t.host = safeDecode(params.get('host')) || ''
      t.mode = params.get('mode') ?? 'auto'
      break
    case 'httpupgrade':
      t.path = safeDecode(params.get('path')) || '/'
      t.host = safeDecode(params.get('host')) || ''
      break
    case 'h2':
    case 'http':
      t.type = 'h2'
      t.path = safeDecode(params.get('path')) || '/'
      t.host = safeDecode(params.get('host')) || ''
      break
    case 'quic':
      t.quicSecurity = params.get('quicSecurity') ?? 'none'
      t.quicKey = params.get('key') ?? ''
      break
  }
  return t
}

// Robust userinfo@host:port parsing via the WHATWG URL parser.
// Handles passwords containing '@' (the LAST '@' separates host). Returns
// null if the URL is malformed. Works for vless/trojan (ss handled separately
// because its userinfo is method:password, often base64).
function splitAuthHost(url: URL): { auth: string; server: string; port: number } | null {
  // URL puts userinfo in .username (+ .password if a ':' separates), host in .hostname.
  // Combine username + password to recover the original auth string.
  let auth = decodeURIComponent(url.username)
  if (url.password) auth += ':' + decodeURIComponent(url.password)
  const server = url.hostname
  const port = Number(url.port)
  if (!server || !port) return null
  return { auth, server, port }
}

// vless://<uuid>@<host>:<port>?<q>#<name>
function parseVlessUri(uri: string): ParsedNode | null {
  let u: URL
  try { u = new URL(uri) } catch { return null }
  if (u.protocol !== 'vless:') return null
  const ah = splitAuthHost(u)
  if (!ah) return null
  const params = u.searchParams
  const tls = parseTlsFromQuery(params, 'vless')
  const transport = parseTransportFromQuery(params)
  return {
    tag: safeDecode(u.hash.slice(1)) || `${ah.server}:${ah.port}`,
    protocol: 'vless',
    server: ah.server,
    port: ah.port,
    auth: ah.auth,
    flow: params.get('flow') ?? '',
    network: transport.type,
    tls,
    transport,
  }
}

// vmess://<base64-json>
function parseVmessUri(uri: string): ParsedNode | null {
  const m = uri.match(/^vmess:\/\/([A-Za-z0-9+/=_-]+)$/i)
  if (!m) return null
  let json: string
  try {
    json = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
  } catch { return null }
  let v: Record<string, unknown>
  try { v = JSON.parse(json) } catch { return null }
  const net = String(v.net ?? 'tcp') as Transport
  const tls: TlsOpts = {
    enabled: String(v.tls ?? '') === 'tls',
    serverName: String(v.sni ?? v.host ?? '') || undefined,
    insecure: String(v.verify_cert ?? 'true') === 'false' ? true : undefined,
    alpn: v.alpn ? String(v.alpn).split(',') : undefined,
    fingerprint: String(v.fp ?? '') || undefined,
  }
  const transport: TransportOpts = { type: net === 'tcp' || net === 'raw' ? 'tcp' : net }
  if (net === 'ws' || net === 'xhttp' || net === 'httpupgrade') {
    transport.path = String(v.path ?? '/')
    transport.host = String(v.host ?? '')
    const headers = v.headers as Record<string, string> | undefined
    if (headers?.Host) { transport.host = headers.Host; delete headers.Host; transport.headers = headers }
  } else if (net === 'grpc') {
    transport.path = String(v.path ?? '')
    transport.serviceName = String(v.path ?? '')
    transport.mode = 'gun'
  } else if (net === 'h2' || net === 'http') {
    transport.path = String(v.path ?? '/')
    transport.host = String(v.host ?? '')
    transport.h2Hosts = v.host ? [String(v.host)] : []
  }
  return {
    tag: String(v.ps ?? v.remarks ?? `${v.add}:${v.port}`),
    protocol: 'vmess',
    server: String(v.add ?? ''),
    port: Number(v.port ?? 0),
    auth: String(v.id ?? ''),
    alterId: Number(v.aid ?? 0),
    cipher: String(v.scy ?? 'auto'),
    network: transport.type,
    tls,
    transport,
  }
}

// trojan://<password>@<host>:<port>?<q>#<name>
function parseTrojanUri(uri: string): ParsedNode | null {
  let u: URL
  try { u = new URL(uri) } catch { return null }
  if (u.protocol !== 'trojan:') return null
  const ah = splitAuthHost(u)
  if (!ah) return null
  const params = u.searchParams
  const tls = parseTlsFromQuery(params, 'trojan')
  const transport = parseTransportFromQuery(params)
  return {
    tag: safeDecode(u.hash.slice(1)) || `${ah.server}:${ah.port}`,
    protocol: 'trojan',
    server: ah.server,
    port: ah.port,
    auth: ah.auth,
    network: transport.type,
    tls,
    transport,
  }
}

// ss://[base64(method:password)]@host:port#name   (SIP002)
// ss://base64(method:password@host:port)#name     (legacy)
function parseShadowsocksUri(uri: string): ParsedNode | null {
  // SIP002: ss://userinfo@host:port#name — userinfo may be base64 OR plaintext.
  // Use URL parser so passwords containing '@' work (last '@' splits host).
  if (uri.includes('@')) {
    let u: URL
    try { u = new URL(uri) } catch { return null }
    if (u.protocol !== 'ss:') return null
    const server = u.hostname
    const port = Number(u.port)
    if (!server || !port) return null
    // Reconstruct raw userinfo (URL decodes %-escapes; SS userinfo is usually
    // base64 so no %-escapes, but be safe).
    let raw = u.username + (u.password ? ':' + u.password : '')
    let method = ''
    let password = ''
    let decoded = raw
    if (!raw.includes(':')) {
      // base64-encoded userinfo → decode to method:password.
      // URL parser leaves %-escapes (e.g. %3D '=') in username — URI-decode
      // BEFORE base64-decode, or the trailing %3D adds a garbage byte.
      try { decoded = Buffer.from(decodeURIComponent(raw), 'base64').toString('utf-8') } catch { /* plaintext */ }
    }
    const colon = decoded.indexOf(':')
    if (colon >= 0) { method = decoded.slice(0, colon); password = decoded.slice(colon + 1) }
    return {
      tag: safeDecode(u.hash.slice(1)) || `${server}:${port}`,
      protocol: 'shadowsocks',
      server,
      port,
      auth: password,
      cipher: method,
      network: 'tcp',
      tls: { enabled: false },
      transport: { type: 'tcp' },
      udp: u.searchParams.get('udp') !== '0',
    }
  }
  // Legacy: ss://base64(method:password@host:port)#name
  const legacy = uri.match(/^ss:\/\/([A-Za-z0-9+/=_-]+)(?:#(.*))?$/i)
  if (legacy) {
    let decoded: string
    try { decoded = Buffer.from(legacy[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8') }
    catch { return null }
    const lm = decoded.match(/^([^:]+):([^@]+)@([^:/?#]+):(\d+)$/)
    if (!lm) return null
    const [, method, password, server, portStr] = lm
    return {
      tag: safeDecode(legacy[2]) || `${server}:${portStr}`,
      protocol: 'shadowsocks',
      server,
      port: Number(portStr),
      auth: password,
      cipher: method,
      network: 'tcp',
      tls: { enabled: false },
      transport: { type: 'tcp' },
    }
  }
  return null
}

// hysteria2://<auth>@<host>:<port>?<q>#<name>   (also hy2:// alias)
// Hysteria2 is QUIC-based; sing-box only (xray does not support it).
// Query: sni, insecure, obfs=salamander, obfs-password=<pw>, up=<mbps>, down=<mbps>.
function parseHysteria2Uri(uri: string): ParsedNode | null {
  const raw = uri.replace(/^hy2:\/\//i, 'hysteria2://')
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'hysteria2:') return null
  const server = u.hostname
  const port = Number(u.port)
  if (!server || !port) return null
  const p = u.searchParams
  return {
    tag: safeDecode(u.hash.slice(1)) || `${server}:${port}`,
    protocol: 'hysteria2',
    server,
    port,
    auth: decodeURIComponent(u.username) || decodeURIComponent(u.password),
    network: 'quic',
    tls: {
      enabled: true,  // hysteria2 is always TLS-over-QUIC
      serverName: p.get('sni') ?? undefined,
      insecure: p.get('insecure') === '1' ? true : undefined,
      alpn: p.get('alpn') ? p.get('alpn')!.split(',') : ['h3'],
    },
    transport: { type: 'quic' },
    upMbps: p.get('up') ? Number(p.get('up')) : undefined,
    downMbps: p.get('down') ? Number(p.get('down')) : undefined,
    obfs: p.get('obfs') === 'salamander' ? (p.get('obfs-password') ?? '') : undefined,
  }
}

// tuic://<uuid>:<password>@<host>:<port>?<q>#<name>   (TUIC v5)
// TUIC is QUIC-based; sing-box only.
// Query: sni, insecure, alpn, congestion_control, udp_relay_mode.
function parseTuicUri(uri: string): ParsedNode | null {
  let u: URL
  try { u = new URL(uri) } catch { return null }
  if (u.protocol !== 'tuic:') return null
  const server = u.hostname
  const port = Number(u.port)
  if (!server || !port) return null
  const p = u.searchParams
  const uuid = decodeURIComponent(u.username)
  const password = decodeURIComponent(u.password)
  return {
    tag: safeDecode(u.hash.slice(1)) || `${server}:${port}`,
    protocol: 'tuic',
    server,
    port,
    auth: uuid,
    network: 'quic',
    tls: {
      enabled: true,  // TUIC is always TLS-over-QUIC
      serverName: p.get('sni') ?? undefined,
      insecure: p.get('insecure') === '1' ? true : undefined,
      alpn: p.get('alpn') ? p.get('alpn')!.split(',') : ['h3'],
    },
    transport: { type: 'quic' },
    // password goes into `auth` too (sing-box needs both uuid + password).
    cipher: password,
    congestionControl: p.get('congestion_control') ?? 'bbr',
    udpRelayMode: p.get('udp_relay_mode') ?? 'native',
  }
}

// WireGuard config-link format (the wg:// URI scheme some subs use).
//   wireguard://<host>:<port>?<q>#<name>
//   q: publickey=<peer-pub>, privatekey=<local-priv>, address=<local-ip>/32,
//      mtu=, reserved=, psk=
// (Also accepts full [Interface]/[Peer] INI config as a fallback.)
//
// NB: keys are base64 — they can contain '+' which URLSearchParams decodes
// to space. We extract raw params manually for the base64 key fields.
function parseWireguardUri(uri: string): ParsedNode | null {
  let u: URL
  try { u = new URL(uri) } catch { return null }
  if (u.protocol !== 'wireguard:') return null
  const server = u.hostname
  const port = Number(u.port)
  if (!server || !port) return null
  // Raw query parse (preserves '+' in base64 keys; URLSearchParams decodes it).
  const rawParams: Record<string, string> = {}
  const qIdx = uri.indexOf('?')
  const rawQuery = qIdx >= 0 ? uri.slice(qIdx + 1).split('#')[0] : ''
  for (const pair of rawQuery.split('&')) {
    const eq = pair.indexOf('=')
    if (eq >= 0) rawParams[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1))
  }
  const localAddr = rawParams['address'] || rawParams['localaddress']
  return {
    tag: safeDecode(u.hash.slice(1)) || `wg:${server}:${port}`,
    protocol: 'wireguard',
    server,
    port,
    auth: '',
    network: 'none',
    tls: { enabled: false },
    transport: { type: 'none' },
    wireguard: {
      localAddress: localAddr ? localAddr.split(',').map((s) => s.trim()) : [],
      privateKey: rawParams['privatekey'] ?? '',
      peerPublicKey: rawParams['publickey'] ?? '',
      preSharedKey: rawParams['presharedkey'] ?? rawParams['psk'] ?? undefined,
      mtu: rawParams['mtu'] ? Number(rawParams['mtu']) : 1280,
      reserved: rawParams['reserved']
        ? (rawParams['reserved'].split(',').map((n) => Number(n.trim())) as [number, number, number])
        : undefined,
    },
  }
}

function parseShareLinks(text: string): { nodes: ParsedNode[]; dropped: number } {
  const nodes: ParsedNode[] = []
  let dropped = 0
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let node: ParsedNode | null = null
    if (trimmed.startsWith('vless://')) node = parseVlessUri(trimmed)
    else if (trimmed.startsWith('vmess://')) node = parseVmessUri(trimmed)
    else if (trimmed.startsWith('trojan://')) node = parseTrojanUri(trimmed)
    else if (trimmed.startsWith('ss://')) node = parseShadowsocksUri(trimmed)
    else if (trimmed.startsWith('hysteria2://') || trimmed.startsWith('hy2://')) node = parseHysteria2Uri(trimmed)
    else if (trimmed.startsWith('tuic://')) node = parseTuicUri(trimmed)
    else if (trimmed.startsWith('wireguard://')) node = parseWireguardUri(trimmed)
    if (!node) continue
    if (isFakeNode(node)) { dropped++; continue }
    nodes.push(node)
  }
  return { nodes, dropped }
}

// ─── subscription-userinfo parsing ──────────────────────────
// Header value: "upload=0; download=5GB; total=100GB; expire=1792245085"
// (sizes могут быть как байты, так и human-readable — нормализуем в байты)
const SIZE_UNITS: Record<string, number> = {
  b: 1, byte: 1, bytes: 1,
  k: 1024, kb: 1024, kib: 1024,
  m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2,
  g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3,
  t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4,
}

export function parseUserInfoHeader(value: string): SubscriptionUserInfo | undefined {
  if (!value) return undefined
  const out: SubscriptionUserInfo = { upload: 0, download: 0, total: 0, expire: 0 }
  let matched = false
  for (const part of value.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    const raw = part.slice(eq + 1).trim()
    const m = raw.match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/i)
    if (!m) continue
    const num = Number(m[1])
    const unit = (m[2] || 'b').toLowerCase()
    const mult = SIZE_UNITS[unit] ?? 1
    const bytes = Math.round(num * mult)
    if (key === 'upload') { out.upload = bytes; matched = true }
    else if (key === 'download') { out.download = bytes; matched = true }
    else if (key === 'total') { out.total = bytes; matched = true }
    else if (key === 'expire') { out.expire = Number(raw); matched = true } // expire = unix seconds, не bytes
  }
  return matched ? out : undefined
}

// ─── Main entry ─────────────────────────────────────────────
export function parseSubscription(rawText: string, opts: { userInfo?: SubscriptionUserInfo } = {}): ParseResult {
  const text = rawText.trim()
  if (!text) return { nodes: [], format: 'unknown', error: 'Empty subscription' }

  try {
    if (looksLikeYaml(text)) {
      const { nodes, dropped } = parseClashYaml(text)
      if (!nodes.length) {
        const msg = dropped > 0
          ? (isClientWhitelistStub(text)
            ? whitelistStubError(dropped)
            : `All ${dropped} node(s) filtered as fake/placeholder (e.g. 0.0.0.0:1 marketing stub). Provider likely requires its own app.`)
          : 'No supported proxy nodes found in Clash YAML (only vless/vmess/trojan/ss parsed)'
        return { nodes: [], format: 'clash-yaml', error: msg, dropped }
      }
      return { nodes, format: 'clash-yaml', userInfo: opts.userInfo, dropped }
    }
    // Share-links (plain or base64-wrapped)
    const decoded = decodeIfBase64(text)
    const linkRe = /vless:\/\/|vmess:\/\/|trojan:\/\/|ss:\/\/|hysteria2:\/\/|hy2:\/\/|tuic:\/\/|wireguard:\//
    if (linkRe.test(decoded)) {
      const { nodes, dropped } = parseShareLinks(decoded)
      if (!nodes.length) {
        const total = (decoded.match(/^(?:vless|vmess|trojan|ss|hysteria2|hy2|tuic|wireguard):\/\//gm) || []).length
        const msg = dropped > 0
          ? (isClientWhitelistStub(decoded)
            ? whitelistStubError(dropped)
            : `All ${total} share-link(s) filtered as fake/placeholder (e.g. 0.0.0.0:1)`)
          : 'No valid share links found (vless/vmess/trojan/ss/hysteria2/tuic/wireguard)'
        return { nodes: [], format: 'share-links', error: msg, dropped }
      }
      return { nodes, format: 'share-links', userInfo: opts.userInfo, dropped }
    }
  } catch (e) {
    return { nodes: [], format: 'unknown', error: `Parse error: ${(e as Error).message}` }
  }

  return { nodes: [], format: 'unknown', error: 'Unrecognized subscription format (not Clash YAML or share links)' }
}
