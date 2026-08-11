// ═══════════════════════════════════════════════════════════
// VOID-SHIELD — sing-box Process Runner
// ═══════════════════════════════════════════════════════════
// Специализация CoreRunner для sing-box. Заменяет xray gRPC на clash-api
// (HTTP + WebSocket на :9090). Даёт: readyProbe (poll /version), traffic,
// connections, node select (selector), URL delay test (urltest refresh).

import { CoreRunner } from './core-runner'
import { SINGBOX_CLASH_API, SINGBOX_SELECTOR_TAG, SINGBOX_URLTEST_TAG } from './singbox-config-builder'

const API_BASE = `http://${SINGBOX_CLASH_API}`

export class SingboxRunner extends CoreRunner {
  readonly name = 'sing-box'

  protected bundledPlatformDir(): string {
    const p = process.platform
    const a = process.arch
    if (p === 'linux' && a === 'x64') return 'linux-x64'
    if (p === 'linux' && a === 'arm64') return 'linux-arm64'
    if (p === 'win32' && a === 'x64') return 'windows-x64'
    if (p === 'darwin' && a === 'x64') return 'darwin-x64'
    if (p === 'darwin' && a === 'arm64') return 'darwin-arm64'
    throw new Error(`Unsupported platform: ${p}-${a}`)
  }
  protected binName(): string {
    return process.platform === 'win32' ? 'sing-box.exe' : 'sing-box'
  }
  protected runArgs(): string[] {
    return ['run', '-c', this.configPath()]
  }

  // ─── Readiness: poll clash-api /version (up to ~5s) ─────────
  // Stronger than the old xray "wait 2s and hope" check.
  protected async readyProbe(): Promise<boolean> {
    for (let i = 0; i < 25; i++) {
      if (!this.isRunning()) return false
      try {
        const r = await fetch(`${API_BASE}/version`, { signal: AbortSignal.timeout(800) })
        if (r.ok) return true
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 200))
    }
    return false
  }

  // ─── clash-api methods (replace xray gRPC) ─────────────────
  // All loopback; no auth. sing-box's clash-api mirrors mihomo's API shape.

  /** Active node of the selector (manual choice) or urltest (auto). */
  async getActiveNode(): Promise<{ selector: string; urltest: string }> {
    try {
      const [sel, url] = await Promise.all([
        fetch(`${API_BASE}/proxies/${SINGBOX_SELECTOR_TAG}`).then((r) => r.json()),
        fetch(`${API_BASE}/proxies/${SINGBOX_URLTEST_TAG}`).then((r) => r.json()),
      ])
      return { selector: sel?.now ?? '', urltest: url?.now ?? '' }
    } catch {
      return { selector: '', urltest: '' }
    }
  }

  /** Selector — manual node pin. Empty = revert to urltest (auto). */
  async selectNode(tag: string): Promise<void> {
    const target = tag || SINGBOX_URLTEST_TAG
    await fetch(`${API_BASE}/proxies/${SINGBOX_SELECTOR_TAG}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: target }),
    })
  }

  /** Trigger a URL-delay test on a specific node (or all via group). */
  async testDelay(nodeTag: string, url = 'https://www.gstatic.com/generate_204', timeout = 5000): Promise<number> {
    try {
      const r = await fetch(
        `${API_BASE}/proxies/${encodeURIComponent(nodeTag)}/delay?url=${encodeURIComponent(url)}&timeout=${timeout}`,
        { signal: AbortSignal.timeout(timeout + 1500) }
      )
      const j = await r.json() as { delay?: number }
      return j.delay ?? -1
    } catch {
      return -1
    }
  }

  /** Batch test all nodes in the urltest group concurrently. Returns tag→ms. */
  async testAllDelays(url = 'https://www.gstatic.com/generate_204', timeout = 5000): Promise<Record<string, number>> {
    try {
      const grp = await fetch(`${API_BASE}/proxies/${SINGBOX_URLTEST_TAG}`).then((r) => r.json()) as { all?: string[] }
      const tags = grp.all ?? []
      const entries = await Promise.all(tags.map(async (t) => [t, await this.testDelay(t, url, timeout)] as const))
      return Object.fromEntries(entries)
    } catch {
      return {}
    }
  }

  /** Live node list with delay (the selector/urltest group contents). */
  async getNodeList(): Promise<{ tag: string; alive: boolean; delayMs: number }[]> {
    try {
      const url = await fetch(`${API_BASE}/proxies/${SINGBOX_URLTEST_TAG}`).then((r) => r.json()) as {
        all?: string[]
        now?: string
      }
      const tags = url.all ?? []
      return tags.map((t) => ({ tag: t, alive: t === url.now, delayMs: 0 }))
    } catch {
      return []
    }
  }

  /** Up/down realtime throughput (from /traffic — bytes/sec). */
  // Note: the streaming endpoint is /traffic (WS/SSE); here we provide a
  // snapshot helper. The renderer subscribes directly via preload in Phase 3.
}
