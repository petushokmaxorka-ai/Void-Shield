// ═══════════════════════════════════════════════════════════
// VOID-SHIELD DESKTOP — Renderer Logic
// ═══════════════════════════════════════════════════════════
// Flow: first run → onboarding modal (subscription URL) → dashboard.
// Dashboard: status, nodes, traffic, logs (Dark Mechanicus theme).

import { isDomesticRuNode, hasAliveNonDomesticRu } from '@shared/node-region'

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const api = window.electronAPI.vpn

let allNodes: NodeRow[] = []
let logLines: string[] = []
const LOG_MAX = 500  // rolling buffer cap (live stream can flood otherwise)
let currentStatus: StatusData | null = null

interface StatusData {
  running: boolean; uptime: number; egressIp: string;
  activeNode: string; override: string; autoMode: boolean; apiOk: boolean;
  socksOk: boolean; tunOk: boolean;
}
interface NodeRow {
  tag: string; server: string; port: number;
  alive: boolean | null; delayMs: number | null; lastError: string;
}
interface AppState {
  hasSubscription: boolean; capsGranted: boolean; needsCaps: boolean;
}

// ─── Helpers ───────────────────────────────────────────────
function setStatus(msg: string, type: 'info' | 'ok' | 'err' = 'info'): void {
  const el = $('status-line')
  if (!msg) { el.className = 'status-line'; el.textContent = ''; return }
  el.className = 'status-line ' + type
  el.textContent = '◆ ' + msg
}

function formatBytes(n: number | null | undefined): string {
  if (n == null || isNaN(n as number)) return '—'
  let v = Number(n)
  for (const unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
    if (v < 1024) return `${v.toFixed(v < 10 ? 1 : 0)} ${unit}`
    v /= 1024
  }
  return `${v.toFixed(1)} PB`
}

function formatUptime(sec: number | null | undefined): string {
  if (!sec) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${s}s`
  return `${m}m ${s}s`
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
}

// ═══ ONBOARDING FLOW ═════════════════════════════════════════
function setOnboardingStatus(msg: string, type: 'info' | 'ok' | 'err' = 'info'): void {
  const el = $('onboarding-status')
  el.className = 'modal-status ' + type
  el.textContent = msg
}

async function registerSubscription(): Promise<void> {
  const input = ($('sub-url') as HTMLInputElement).value.trim()
  if (!input) { setOnboardingStatus('◆ PASTE A URL OR SHARE-LINK', 'err'); return }

  const btn = $('btn-register') as HTMLButtonElement
  btn.disabled = true; btn.textContent = '◆ REGISTERING...'
  const btnImport = document.getElementById('btn-import-file') as HTMLButtonElement | null
  const btnFl = document.getElementById('btn-import-flclash') as HTMLButtonElement | null
  if (btnImport) btnImport.disabled = true
  if (btnFl) btnFl.disabled = true

  try {
    // Persist optional Custom UA before fetch (tried first by main process).
    const uaField = document.getElementById('custom-ua') as HTMLInputElement | null
    if (uaField && api.setCustomUserAgent) {
      await api.setCustomUserAgent(uaField.value.trim())
    }

    // Universal paste & go — detect input format:
    //   http(s):// → fetch subscription (UA negotiation + FlClashX fallback)
    //   vless/vmess/trojan/ss/hysteria2/tuic/wireguard:// → single share-link
    //   base64 blob → decode → list of share-links
    //   else → assume raw Clash YAML
    const isUrl = /^https?:\/\//i.test(input)
    let result: { nodes: number; format: string; source?: string }
    if (isUrl) {
      setOnboardingStatus('◆ FETCHING SUBSCRIPTION...', 'info')
      result = (await api.updateSubscription(input)) as { nodes: number; format: string; source?: string }
    } else {
      setOnboardingStatus('◆ PARSING CONFIG...', 'info')
      const r = (await api.importFromText(input)) as { ok: boolean; nodes?: number; format?: string; error?: string }
      if (!r.ok || !r.nodes) {
        setOnboardingStatus(`◆ PARSE FAILED: ${r.error ?? 'no nodes'}`, 'err')
        return
      }
      result = { nodes: r.nodes, format: r.format ?? 'unknown' }
    }
    const srcNote = result.source === 'flclash-cache' ? ' [FLCLASHX CACHE]' : ''
    setOnboardingStatus(`◆ CONTRACT PARSED: ${result.nodes} NODES (${result.format})${srcNote}`, 'ok')

    // Grant capabilities if needed (Linux TUN).
    const state = (await api.getState()) as AppState
    if (state.needsCaps && !state.capsGranted) {
      setOnboardingStatus('◆ REQUESTING TUN PERMISSIONS (ENTER PASSWORD)...', 'info')
      const capResult = (await api.grantCapabilities()) as { ok: boolean; error?: string }
      if (!capResult.ok) {
        setOnboardingStatus(`◆ TUN GRANT FAILED: ${capResult.error} (VPN may not capture all traffic)`, 'err')
        // Continue anyway — app still works in SOCKS mode.
      }
    }

    setOnboardingStatus('◆ IGNITING HERETIC FIELD...', 'info')
    const startResult = (await api.start()) as { ok: boolean; error?: string }
    if (!startResult.ok) {
      setOnboardingStatus(`◆ IGNITION FAILED: ${startResult.error}`, 'err')
      return
    }

    // Success — hide modal, show dashboard.
    setOnboardingStatus('◆ FIELD ACTIVE', 'ok')
    $('onboarding-overlay').classList.add('hidden')
    finishBoot(false)
    await refreshAll()
    startPolling()
  } catch (e) {
    setOnboardingStatus('◆ ' + (e as Error).message, 'err')
  } finally {
    btn.disabled = false; btn.textContent = '◆ REGISTER & IGNITE'
    if (btnImport) btnImport.disabled = false
    if (btnFl) btnFl.disabled = false
  }
}

async function afterConfigImport(r: { ok: boolean; nodes?: number; format?: string; error?: string; source?: string }): Promise<void> {
  if (!r.ok || !r.nodes) {
    setOnboardingStatus(`◆ IMPORT FAILED: ${r.error ?? 'no nodes parsed'}`, 'err')
    return
  }
  const srcNote = r.source === 'flclash-cache' ? ' [FLCLASHX]' : ''
  setOnboardingStatus(`◆ PARSED: ${r.nodes} NODES (${r.format ?? 'unknown'})${srcNote}`, 'ok')
  const state = (await api.getState()) as AppState
  if (state.needsCaps && !state.capsGranted) {
    setOnboardingStatus('◆ REQUESTING TUN PERMISSIONS (ENTER PASSWORD)...', 'info')
    const capResult = (await api.grantCapabilities()) as { ok: boolean; error?: string }
    if (!capResult.ok) setOnboardingStatus(`◆ TUN GRANT FAILED: ${capResult.error}`, 'err')
  }
  setOnboardingStatus('◆ IGNITING HERETIC FIELD...', 'info')
  const startResult = (await api.start()) as { ok: boolean; error?: string }
  if (!startResult.ok) { setOnboardingStatus(`◆ IGNITION FAILED: ${startResult.error}`, 'err'); return }
  setOnboardingStatus('◆ FIELD ACTIVE', 'ok')
  $('onboarding-overlay').classList.add('hidden')
  finishBoot(false)
  await refreshAll()
  startPolling()
}

// Phase 5: import from local file (Clash YAML / xray JSON / vless:// links).
// Bypasses the subscription URL entirely — for users with a local config
// (e.g. exported from another client, or hand-edited). Works offline.
async function importFromFile(): Promise<void> {
  const btn = document.getElementById('btn-import-file') as HTMLButtonElement | null
  if (!btn) return
  btn.disabled = true; btn.textContent = '◆ OPENING...'
  setOnboardingStatus('◆ SELECT CONFIG FILE...', 'info')
  try {
    const r = (await api.importFromFile()) as { ok: boolean; nodes?: number; format?: string; error?: string }
    await afterConfigImport(r)
  } catch (e) {
    setOnboardingStatus('◆ ' + (e as Error).message, 'err')
  } finally {
    btn.disabled = false; btn.textContent = '⎘ IMPORT FILE'
  }
}

async function importFromFlClash(): Promise<void> {
  const btn = document.getElementById('btn-import-flclash') as HTMLButtonElement | null
  if (btn) { btn.disabled = true; btn.textContent = '◆ LOADING...' }
  setOnboardingStatus('◆ READING FLCLASHX PROFILE...', 'info')
  try {
    const preferred = ($('sub-url') as HTMLInputElement).value.trim()
    const r = (await api.importFromFlClash(preferred || undefined)) as {
      ok: boolean; nodes?: number; format?: string; error?: string; source?: string
    }
    await afterConfigImport(r)
  } catch (e) {
    setOnboardingStatus('◆ ' + (e as Error).message, 'err')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⎘ IMPORT FLCLASHX' }
  }
}

// ═══ DASHBOARD (after onboarding) ═══════════════════════════
function formatStatusDetail(d: StatusData): string {
  const parts: string[] = []
  if (d.socksOk) parts.push('socks up')
  if (d.tunOk) parts.push('tun up')
  if (d.apiOk) parts.push('api ok')
  if (!parts.length) parts.push('core starting')
  return `${parts.join(' | ')} | uplink ${formatUptime(d.uptime)}`
}

async function loadStatus(): Promise<void> {
  try {
    const d = (await api.getStatus()) as StatusData
    currentStatus = d
    const active = d.running
    const banner = $('status-banner')
    const big = $('big-status')
    banner.className = 'status-banner ' + (active ? 'online' : 'offline')
    big.className = 'big-status ' + (active ? 'online pulse' : 'offline')
    big.textContent = active ? '● VOID-SHIELD ACTIVE' : '○ FIELD DOWN'
    const sub = $('subtitle')
    sub.textContent = active ? 'HERETIC FIELD ACTIVE — CRIMSON UPLINK STABLE' : 'FIELD OFFLINE — NO PROTECTION'
    const detail = $('status-detail')
    detail.textContent = active ? formatStatusDetail(d) : 'press IGNITE to raise the shield'
    ;($('egress-ip') as HTMLElement).textContent = d.egressIp || '—'
    // Pinned override wins — activeNode from balancer principle_target can lag observatory leastPing.
    ;($('active-node') as HTMLElement).textContent = d.override || d.activeNode || '—'
    ;($('uptime') as HTMLElement).textContent = formatUptime(d.uptime)
    const modeEl = $('mode') as HTMLElement
    modeEl.textContent = d.autoMode ? 'AUTO (LEASTPING)' : 'MANUAL'
    modeEl.className = 'metric-card-value ' + (d.autoMode ? '' : 'metric-orange')
  } catch (e) {
    ;($('big-status') as HTMLElement).textContent = '✗ API ERROR'
    ;($('status-detail') as HTMLElement).textContent = (e as Error).message
  }
}

function delayColor(ms: number | null): string {
  if (ms == null) return 'dead'
  return ms < 800 ? '' : 'slow'
}

function renderNodes(): void {
  const filter = ($('node-filter') as HTMLInputElement).value.trim().toLowerCase()
  const list = $('nodes-list')
  let nodes = allNodes
  if (filter) nodes = nodes.filter((n) => n.tag.toLowerCase().includes(filter))
  if (!nodes.length) {
    list.innerHTML = `<div class="empty">${filter ? 'NO MATCHING NODES' : 'NO NODES'}</div>`
    return
  }
  const active = currentStatus ? (currentStatus.override || currentStatus.activeNode) : ''
  const sinkDomestic = hasAliveNonDomesticRu(allNodes)
  let domesticHeader = false
  list.innerHTML = nodes.map((n) => {
    let section = ''
    if (sinkDomestic && isDomesticRuNode(n.tag) && !domesticHeader) {
      domesticHeader = true
      section = '<div class="list-section">🇷🇺 DOMESTIC RU — FALLBACK ONLY (NO BYPASS)</div>'
    }
    const isActive = n.tag === active
    const cls = n.alive === true ? 'live' : (n.alive === false ? 'dead' : '')
    const delayCls = n.alive === false ? 'dead' : delayColor(n.delayMs)
    const delayTxt = n.delayMs != null ? `${n.delayMs}MS` : (n.alive === false ? 'DEAD' : '—')
    return `${section}<div class="list-item ${isActive ? 'active-node' : ''}" data-tag="${escapeHtml(n.tag)}">
      <div class="list-name ${cls}">${escapeHtml(n.tag)}</div>
      <div class="list-meta">${escapeHtml((n.server || '').split('.')[0])}<br>${n.port || ''}</div>
      <div class="list-delay ${delayCls}" title="${escapeHtml(n.lastError || '')}">${delayTxt}</div>
    </div>`
  }).join('')
  list.querySelectorAll('.list-item').forEach((el) => {
    el.addEventListener('click', () => selectNode((el as HTMLElement).dataset.tag || ''))
  })
  const alive = allNodes.filter((n) => n.alive === true).length
  ;($('nodes-summary') as HTMLElement).textContent = `${alive} ALIVE / ${allNodes.length}`
}

async function loadNodes(): Promise<void> {
  try {
    const d = (await api.getNodes()) as { nodes: NodeRow[] }
    allNodes = d.nodes || []
    renderNodes()
  } catch (e) {
    ;($('nodes-list') as HTMLElement).innerHTML = `<div class="error">OBSERVATORY ERROR: ${escapeHtml((e as Error).message)}</div>`
  }
}

async function selectNode(tag: string): Promise<void> {
  if (!confirm(`ROUTE ALL TRAFFIC THROUGH:\n${tag}\n\n(this pins the balancer; use AUTO to revert)`)) return
  setStatus('PINNING NODE...', 'info')
  try {
    await api.selectNode(tag)
    setStatus(`NODE PINNED: ${tag}`, 'ok')
    await loadStatus(); await loadNodes()
  } catch (e) { setStatus('PIN FAILED: ' + (e as Error).message, 'err') }
}

async function loadTraffic(): Promise<void> {
  try {
    const d = (await api.getTraffic()) as { inboundUp: number; inboundDown: number; uptime: number; goroutines: number; allocBytes: number; error?: string }
    const el = $('traffic-content')
    if (d.error) {
      el.innerHTML = `<div class="empty">STATS UNAVAILABLE<br><span style="font-size:8px">${escapeHtml(d.error)}</span></div>`
      return
    }
    el.innerHTML = `
      <div class="metric-row"><span class="metric-label">INBOUND UP</span><span class="metric-value">${formatBytes(d.inboundUp)}</span></div>
      <div class="metric-row"><span class="metric-label">INBOUND DOWN</span><span class="metric-value">${formatBytes(d.inboundDown)}</span></div>
      <div class="metric-row"><span class="metric-label">XRAY UPTIME</span><span class="metric-value">${formatUptime(d.uptime)}</span></div>
      <div class="metric-row"><span class="metric-label">GOROUTINES</span><span class="metric-value">${d.goroutines || '—'}</span></div>
      <div class="metric-row"><span class="metric-label">ALLOC</span><span class="metric-value">${formatBytes(d.allocBytes)}</span></div>`
  } catch (e) { ;($('traffic-content') as HTMLElement).innerHTML = `<div class="error">${escapeHtml((e as Error).message)}</div>` }
}

async function loadLogs(): Promise<void> {
  try {
    const d = (await api.getLogs(200)) as string[]
    logLines = d || []
    renderLogs()
  } catch (e) { logLines = ['LOG ERROR: ' + (e as Error).message]; renderLogs() }
}

function renderLogs(): void {
  const filter = ($('log-filter') as HTMLInputElement).value.trim().toLowerCase()
  const lines = filter ? logLines.filter((l) => l.toLowerCase().includes(filter)) : logLines
  const box = $('log-box')
  box.textContent = lines.join('\n') || (filter ? 'NO MATCHING LINES' : 'NO LOGS')
  box.scrollTop = box.scrollHeight
}

async function serviceAction(action: 'start' | 'stop' | 'restart', btn: HTMLButtonElement): Promise<void> {
  const needsConfirm = action === 'stop'
  if (needsConfirm && !confirm('EXTINGUISH VOID-SHIELD? This stops all VPN traffic.')) return
  btn.disabled = true; const old = btn.textContent; btn.textContent = '...'
  setStatus(`${action.toUpperCase()}...`, 'info')
  try {
    const r = (await api[action === 'start' ? 'start' : action === 'stop' ? 'stop' : 'restart']()) as { ok: boolean; error?: string }
    if (r.ok) setStatus(`${action.toUpperCase()} OK`, 'ok')
    else setStatus(`${action.toUpperCase()} FAILED: ${r.error}`, 'err')
    await loadStatus()
  } catch (e) { setStatus(`${action.toUpperCase()} FAILED: ` + (e as Error).message, 'err') }
  finally { btn.disabled = false; btn.textContent = old }
}

async function goAuto(): Promise<void> {
  setStatus('REVERTING TO AUTO...', 'info')
  try { await api.autoSelect(); setStatus('AUTO MODE RESTORED', 'ok'); await loadStatus() }
  catch (e) { setStatus('AUTO FAILED: ' + (e as Error).message, 'err') }
}

// ─── Phase 3: scenario + core + quota + batch ping + clipboard ──

// Quota human formatting (bytes → XX GB).
function fmtBytes(b: number): string {
  if (!b || b < 0) return '∞'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0; let n = b
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`
}

async function loadScenarioCore(): Promise<void> {
  try {
    const settings = await api.getSettings()
    const scenario = (settings as { scenario?: string })?.scenario ?? 'bypass-lan'
    const core = (settings as { core?: string })?.core ?? 'singbox'
    ;($('scenario-select') as HTMLSelectElement).value = scenario
    ;($('core-select') as HTMLSelectElement).value = core
  } catch { /* ignore */ }
}

async function loadQuota(): Promise<void> {
  try {
    const q = await api.getQuota() as { upload: number; download: number; total: number; expire: number } | null
    if (!q) { ($('quota-bar-wrap') as HTMLElement).style.display = 'none'; return }
    ;($('quota-bar-wrap') as HTMLElement).style.display = 'block'
    const used = q.upload + q.download
    const pct = q.total > 0 ? Math.min(100, (used / q.total) * 100) : 0
    ;($('quota-fill') as HTMLElement).style.width = `${pct}%`
    // Color: green <70%, orange <95%, red ≥95%.
    const fill = $('quota-fill') as HTMLElement
    fill.className = 'progress-fill' + (pct < 70 ? ' green' : pct < 95 ? '' : '')
    ;($('quota-text') as HTMLElement).textContent = q.total > 0
      ? `${fmtBytes(used)} / ${fmtBytes(q.total)}`
      : `${fmtBytes(used)} / ∞`
    if (q.expire > 0) {
      const days = Math.max(0, Math.floor((q.expire * 1000 - Date.now()) / 86400000))
      ;($('quota-expire') as HTMLElement).textContent = days > 0 ? `${days} days` : 'EXPIRED'
    } else {
      ;($('quota-expire') as HTMLElement).textContent = '∞'
    }
  } catch { /* ignore */ }
}

async function onScenarioChange(): Promise<void> {
  const sel = $('scenario-select') as HTMLSelectElement
  sel.disabled = true
  const r = await api.switchScenario(sel.value) as { ok: boolean; error?: string }
  sel.disabled = false
  if (!r.ok) alert('Scenario switch failed: ' + (r.error ?? 'unknown'))
  await refreshAll()
}

async function onCoreChange(): Promise<void> {
  const sel = $('core-select') as HTMLSelectElement
  if (!confirm(`Switch core to ${sel.value}? This will restart the engine.`)) {
    await loadScenarioCore(); return
  }
  sel.disabled = true
  const r = await api.switchCore(sel.value) as { ok: boolean; error?: string }
  sel.disabled = false
  if (!r.ok) alert('Core switch failed: ' + (r.error ?? 'unknown'))
  await refreshAll()
}

async function testAllDelays(): Promise<void> {
  const btn = $('btn-test-delays') as HTMLButtonElement
  const status = $('ping-status') as HTMLElement
  btn.disabled = true; status.textContent = 'PROBING...'
  try {
    const delays = await api.testDelays() as Record<string, number>
    const n = Object.keys(delays).length
    const alive = Object.values(delays).filter((d) => d > 0).length
    status.textContent = n > 0 ? `${alive}/${n} ALIVE` : 'XRAY CORE (no clash-api)'
    if (n > 0) await loadNodes()
  } catch (e) {
    status.textContent = 'FAILED'
  } finally {
    btn.disabled = false
    setTimeout(() => { status.textContent = '' }, 5000)
  }
}

async function checkClipboardOnFocus(): Promise<void> {
  try {
    const text = await api.checkClipboardForLink() as string
    const btn = $('btn-import-clipboard') as HTMLButtonElement
    if (text) {
      btn.style.display = 'inline-flex'
      btn.textContent = `⎘ IMPORT (${text.slice(0, 30)}${text.length > 30 ? '…' : ''})`
      btn.onclick = async () => {
        const r = await api.importFromText(text) as { ok: boolean; nodes?: number; error?: string }
        if (r.ok) { btn.style.display = 'none'; await refreshAll() }
        else alert('Import failed: ' + (r.error ?? 'unknown'))
      }
    } else {
      btn.style.display = 'none'
    }
  } catch { /* ignore */ }
}

async function loadSubscriptionInfo(): Promise<void> {
  // Replace the placeholder "LOADING..." with real subscription metadata.
  const settings = await api.getSettings() as { subscriptionUrl?: string; lastUpdate?: number }
  const el = $('sub-content') as HTMLElement
  const url = settings.subscriptionUrl || ''
  const lastUpdate = settings.lastUpdate ? new Date(settings.lastUpdate).toLocaleString() : '—'
  el.innerHTML = url
    ? `<div class="metric-row"><span class="metric-label">UPLINK</span><span class="metric-value" style="font-size:10px;word-break:break-all">${url.replace(/(token|key|sub\/)[a-zA-Z0-9_-]+/i, '$1••••')}</span></div>
       <div class="metric-row"><span class="metric-label">LAST SYNC</span><span class="metric-value" style="font-size:10px">${lastUpdate}</span></div>`
    : `<div class="empty">NO SUBSCRIPTION URL — imported manually</div>
       <div class="metric-row"><span class="metric-label">LAST SYNC</span><span class="metric-value" style="font-size:10px">${lastUpdate}</span></div>`
}

async function refreshAll(): Promise<void> {
  const btn = $('refresh-btn') as HTMLButtonElement
  btn.disabled = true; btn.textContent = '◆ UPDATING...'
  await Promise.all([loadStatus(), loadNodes(), loadTraffic(), loadLogs(), loadScenarioCore(), loadQuota(), loadSubscriptionInfo()])
  btn.disabled = false; btn.textContent = '◆ REFRESH'
}

// Polling (logs poll slow — real-time stream via onLogEvent is primary;
// this is just a fallback for xray-core which has no clash-api WS).
function startPolling(): void {
  setInterval(loadStatus, 5000)
  setInterval(loadNodes, 15000)
  setInterval(loadTraffic, 20000)
  setInterval(loadLogs, 60000)
}

// ─── Init: check onboarding vs dashboard ───────────────────
async function init(): Promise<void> {
  // Bindings (only relevant after onboarding, but bind early).
  ($('btn-register') as HTMLButtonElement).addEventListener('click', registerSubscription)
  // Phase 5: import from local file (Clash YAML / xray JSON / vless:// .txt).
  const importBtn = document.getElementById('btn-import-file') as HTMLButtonElement | null
  if (importBtn) importBtn.addEventListener('click', importFromFile)
  const flBtn = document.getElementById('btn-import-flclash') as HTMLButtonElement | null
  if (flBtn) flBtn.addEventListener('click', () => { void importFromFlClash() })
  const dashFl = document.getElementById('btn-dash-import-flclash') as HTMLButtonElement | null
  if (dashFl) {
    dashFl.addEventListener('click', async () => {
      dashFl.disabled = true
      try {
        const settings = await api.getSettings() as { subscriptionUrl?: string }
        const r = await api.importFromFlClash(settings.subscriptionUrl || undefined) as {
          ok: boolean; nodes?: number; error?: string; source?: string
        }
        if (!r.ok) { alert('FlClashX import failed: ' + (r.error ?? 'unknown')); return }
        setStatus(`IMPORTED FLCLASHX: ${r.nodes} NODES`, 'ok')
        await refreshAll()
      } catch (e) {
        alert((e as Error).message)
      } finally {
        dashFl.disabled = false
      }
    })
  }
  ;($('sub-url') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') registerSubscription()
  })
  ;($('refresh-btn') as HTMLButtonElement).addEventListener('click', refreshAll)
  ;($('btn-start') as HTMLButtonElement).addEventListener('click', (e) => serviceAction('start', e.target as HTMLButtonElement))
  ;($('btn-stop') as HTMLButtonElement).addEventListener('click', (e) => serviceAction('stop', e.target as HTMLButtonElement))
  ;($('btn-restart') as HTMLButtonElement).addEventListener('click', (e) => serviceAction('restart', e.target as HTMLButtonElement))
  ;($('btn-auto') as HTMLButtonElement).addEventListener('click', goAuto)
  ;($('node-filter') as HTMLInputElement).addEventListener('input', renderNodes)
  ;($('filter-clear') as HTMLButtonElement).addEventListener('click', () => { ($('node-filter') as HTMLInputElement).value = ''; renderNodes() })
  ;($('log-filter') as HTMLInputElement).addEventListener('input', renderLogs)
  ;($('log-clear-filter') as HTMLButtonElement).addEventListener('click', () => { ($('log-filter') as HTMLInputElement).value = ''; renderLogs() })

  // Phase 3 bindings
  ;($('scenario-select') as HTMLSelectElement).addEventListener('change', onScenarioChange)
  ;($('core-select') as HTMLSelectElement).addEventListener('change', onCoreChange)
  ;($('btn-test-delays') as HTMLButtonElement).addEventListener('click', testAllDelays)
  // Clipboard check on window focus + every 30s.
  window.addEventListener('focus', checkClipboardOnFocus)
  setInterval(checkClipboardOnFocus, 30000)

  // Phase 4: subscribe to real-time log stream (sing-box clash-api WS bridge).
  // Each pushed line appends to the rolling buffer + re-renders (cheap; capped).
  api.onLogEvent((line) => {
    logLines.push(line)
    while (logLines.length > LOG_MAX) logLines.shift()
    // Only re-render if the log panel is currently the focus (cheap enough).
    renderLogs()
  })

  // Phase 5: deep-link import (void-shield://import?url=...) — pre-fill + register.
  if (api.onImportUrl) {
    api.onImportUrl((url: string) => {
      const field = $('sub-url') as HTMLInputElement
      if (field) field.value = url
      $('onboarding-overlay').classList.remove('hidden')
      void registerSubscription()
    })
  }

  // Check state: subscription exists?
  const state = (await api.getState()) as AppState
  // Prefill custom UA from settings (if any).
  try {
    const settings = await api.getSettings() as { customUserAgent?: string }
    const uaField = document.getElementById('custom-ua') as HTMLInputElement | null
    if (uaField && settings.customUserAgent) uaField.value = settings.customUserAgent
  } catch { /* ignore */ }
  if (state.hasSubscription) {
    // Already onboarded → show dashboard.
    await refreshAll()
    startPolling()
    finishBoot(false)
  } else {
    // First run → show onboarding modal.
    finishBoot(true)
    $('onboarding-overlay').classList.remove('hidden')
    ;($('sub-url') as HTMLInputElement).focus()
  }
}

// ─── Phase 4: boot sequence ─────────────────────────────────
// Typed log lines that reveal as the dashboard initializes. Gives the
// "Cogitator powering up" feel. Disappears when init() completes.
async function runBootSequence(): Promise<void> {
  const log = $('boot-log')
  if (!log) return
  const lines: { t: string; cls?: string }[] = [
    { t: '> IGNITING HERETIC COGITATOR...' },
    { t: '> LOADING CRIMSON DOCTRINE MODULES', cls: 'ok' },
    { t: '> CALIBRATING VOID FIELD MATRIX...' },
    { t: '> PROBING SUBSCRIPTION UPLINK...' },
  ]
  for (const l of lines) {
    const div = document.createElement('div')
    div.className = 'line' + (l.cls ? ' ' + l.cls : '')
    div.textContent = l.t
    log.appendChild(div)
    await new Promise((r) => setTimeout(r, 280))
  }
}

function finishBoot(_onboarding: boolean): void {
  // Brief final line then fade out.
  const log = $('boot-log')
  if (log) {
    const div = document.createElement('div')
    div.className = 'line ok'
    div.textContent = _onboarding ? '> AWAITING HERETIC UPLINK REGISTRATION_' : '> FIELD GENERATORS ONLINE — WELCOME, ARCHMAGOS_'
    log.appendChild(div)
  }
  setTimeout(() => {
    const ov = $('boot-overlay')
    if (ov) {
      ov.style.transition = 'opacity 0.4s'
      ov.style.opacity = '0'
      setTimeout(() => ov.classList.add('hidden'), 400)
    }
  }, 600)
}

void (async () => {
  await runBootSequence()
  await init()
})()
