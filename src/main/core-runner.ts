// ═══════════════════════════════════════════════════════════
// VOID-SHIELD — Core Runner (base class for xray / sing-box)
// ═══════════════════════════════════════════════════════════
// Базовый lifecycle-менеджер для proxy-core процесса. Даёт то, чего
// не было в старом xray-runner: async-log-write (не блокирует main),
// bounded log (truncate на старте), restart-on-crash, readiness-probe.
//
// SECURITY (AGENTS.md §3.2): spawn с аргументами, NEVER shell:true.

import { spawn, ChildProcess } from 'child_process'
import { join, dirname } from 'path'
import { existsSync, mkdirSync, chmodSync, copyFileSync, writeFile, readFile, createReadStream, truncate } from 'fs'
import { createInterface } from 'readline'
import { app } from 'electron'
import { promisify } from 'util'
const writeFileAsync = promisify(writeFile)
const readFileAsync = promisify(readFile)
const truncateAsync = promisify(truncate)

export abstract class CoreRunner {
  abstract readonly name: string           // "xray" | "sing-box"
  protected proc: ChildProcess | null = null
  protected startedAt = 0
  protected restarting = false
  private intentionalStop = false
  private restartAttempts = 0
  private readonly MAX_RESTART_ATTEMPTS = 5

  // ─── Paths (portable через app.getPath) ────────────────────
  dataDir(): string { return app.getPath('userData') }
  binDir(): string { return join(this.dataDir(), 'bin') }
  configPath(): string { return join(this.dataDir(), this.name + '-config.json') }
  logPath(): string { return join(this.dataDir(), this.name + '.log') }

  // Subclasses tell us the bundled platform-dir + binary name.
  protected abstract bundledPlatformDir(): string
  protected abstract binName(): string  // "xray" | "xray.exe" | "sing-box" | "sing-box.exe"
  protected abstract runArgs(): string[]  // e.g. ['run','-c',configPath()]

  binaryPath(): string { return join(this.binDir(), this.binName()) }

  // ─── Extract bundled binary to writable userData on first run ──
  // (AppImage mount is read-only; sing-box/xray need writable home for setcap.)
  // Robust path resolution: try process.resourcesPath, then several fallbacks
  // (AppImage layout varies between electron-builder versions / dev mode).
  private findBundledBinary(): string {
    const rel = join('bin', this.bundledPlatformDir(), this.binName())
    const candidates = [
      process.resourcesPath ? join(process.resourcesPath, rel) : '',
      join(__dirname, '../../resources', rel),     // dev / unpacked
      join(__dirname, '../../../resources', rel),   // some bundlings
      join(__dirname, '../../../bin', this.bundledPlatformDir(), this.binName()), // extraResources at root
      join(process.resourcesPath ?? '', rel),       // explicit
    ].filter(Boolean)
    for (const c of candidates) {
      if (c && existsSync(c)) return c
    }
    throw new Error(
      `Bundled ${this.name} not found. Tried:\n  - ${candidates.join('\n  - ')}\n` +
      `(resourcesPath=${process.resourcesPath ?? 'undefined'}, __dirname=${__dirname})`
    )
  }

  ensureExtracted(): void {
    const dest = this.binaryPath()
    let bundledDir: string
    if (existsSync(dest)) {
      // Even if the binary exists, ensure geo data / wintun are present (they
      // may have been added in a later build). Idempotent.
      bundledDir = dirname(this.findBundledBinary())
      this.extractGeoData(bundledDir)
    } else {
      mkdirSync(this.binDir(), { recursive: true })
      const srcPath = this.findBundledBinary()
      bundledDir = dirname(srcPath)
      console.log(`[void-shield] extracting ${this.name}: ${srcPath} → ${dest}`)
      copyFileSync(srcPath, dest)
      chmodSync(dest, 0o755)
      this.extractGeoData(bundledDir)
    }
    // Windows xray: always refresh wintun.dll when bundled (TUN needs it).
    if (process.platform === 'win32' && this.name === 'xray') {
      const wintunSrc = join(bundledDir, 'wintun.dll')
      if (existsSync(wintunSrc)) {
        try { copyFileSync(wintunSrc, join(this.binDir(), 'wintun.dll')) } catch { /* ignore */ }
      }
    }
  }

  // Copy geoip.dat + geosite.dat from the bundled resources into bin/.
  // Without these, any routing rule referencing geoip:/geosite: makes xray
  // exit with code 23 ("failed to open geoip.dat").
  private extractGeoData(bundledDir: string): void {
    for (const dat of ['geoip.dat', 'geosite.dat']) {
      const dest = join(this.binDir(), dat)
      if (existsSync(dest)) continue  // already present
      // .dat files are bundled at resources/bin/ root (not per-platform).
      const src = join(bundledDir, '..', dat)  // bin/<platform>/.. = bin/
      const srcAlt = join(bundledDir, dat)
      const srcRoot = join(bundledDir, '..', '..', 'bin', dat)
      for (const candidate of [src, srcAlt, srcRoot]) {
        if (existsSync(candidate)) {
          try {
            copyFileSync(candidate, dest)
            console.log(`[void-shield] extracted ${dat}`)
            break
          } catch { /* ignore — non-fatal */ }
        }
      }
    }
  }

  // ─── State ─────────────────────────────────────────────────
  isRunning(): boolean {
    return this.proc !== null && !this.proc.killed && this.proc.exitCode === null
  }
  startedTime(): number { return this.startedAt }

  // ─── Readiness probe (subclass may override; default: just running) ──
  // sing-box overrides this to poll clash-api for up to 5s.
  protected async readyProbe(): Promise<boolean> {
    return this.isRunning()
  }

  // ─── Write config ──────────────────────────────────────────
  async writeConfig(configObj: Record<string, unknown>): Promise<void> {
    await writeFileAsync(this.configPath(), JSON.stringify(configObj, null, 2), 'utf-8')
  }

  // ─── Start (with crash-recovery) ───────────────────────────
  async start(): Promise<void> {
    if (this.isRunning()) return
    this.ensureExtracted()
    if (!existsSync(this.configPath())) {
      throw new Error(`No ${this.name} config — set up a subscription first`)
    }
    // Truncate log on each start (bounded — fixes the old "log grows forever" bug).
    try { await truncateAsync(this.logPath()) } catch { /* may not exist yet */ }
    await this.writeLogMarker(`--- VOID-SHIELD ${this.name} start ${new Date().toISOString()} ---`)

    await this.spawnCore()
    // Readiness window — give core up to 5s to bind / respond.
    const ok = await this.readyProbe()
    if (!ok && !this.isRunning()) {
      // Brief pause so async stderr flush lands in the log before we read it.
      await new Promise((r) => setTimeout(r, 150))
      const tail = (await this.tailLog(30)).slice(-12)
      const hint = tail.length
        ? `\n--- ${this.name} log ---\n${tail.join('\n')}`
        : ''
      throw new Error(`${this.name} did not stay running${hint}`)
    }
    this.restartAttempts = 0  // successful start resets backoff
  }

  // ─── Internal: spawn the core process + wire crash handler ──
  protected async spawnCore(): Promise<void> {
    const bin = this.binaryPath()
    this.proc = spawn(bin, this.runArgs(), {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.startedAt = Date.now()

    // Async log write (fixes the old appendFileSync-per-line main-thread block).
    const logStream = (stream: NodeJS.ReadableStream | null): void => {
      if (!stream) return
      const rl = createInterface({ input: stream })
      rl.on('line', (line) => { void this.writeLog(line) })
    }
    logStream(this.proc.stdout)
    logStream(this.proc.stderr)

    this.proc.on('error', (err) => {
      void this.writeLog(`${this.name} spawn error: ${err.message}`)
      this.proc = null
    })
    this.proc.on('exit', (code, signal) => {
      void this.writeLog(`${this.name} exited code=${code} signal=${signal}`)
      const wasRunning = this.startedAt > 0 && Date.now() - this.startedAt > 3000
      this.proc = null
      // Recover from unexpected exits (including code=0 — xray sometimes exits
      // cleanly after TUN/observatory faults). Skip when user called stop().
      if (wasRunning && !this.restarting && !this.intentionalStop) {
        void this.maybeRestart()
      }
    })
  }

  // ─── Restart-on-crash (the big missing feature) ────────────
  protected async maybeRestart(): Promise<void> {
    if (this.restartAttempts >= this.MAX_RESTART_ATTEMPTS) {
      await this.writeLog(`${this.name} gave up after ${this.MAX_RESTART_ATTEMPTS} restart attempts`)
      return
    }
    this.restartAttempts++
    this.restarting = true
    // Exponential backoff: 2s, 4s, 8s, 16s, 32s.
    const delay = 2000 * Math.pow(2, this.restartAttempts - 1)
    await this.writeLog(`${this.name} crashed — restart attempt ${this.restartAttempts}/${this.MAX_RESTART_ATTEMPTS} in ${delay}ms`)
    await new Promise((r) => setTimeout(r, delay))
    try {
      if (!this.isRunning()) {
        await this.spawnCore()
        const ok = await this.readyProbe()
        if (ok) {
          await this.writeLog(`${this.name} recovered on attempt ${this.restartAttempts}`)
          this.restartAttempts = 0
        }
      }
    } catch (e) {
      await this.writeLog(`${this.name} restart failed: ${(e as Error).message}`)
    } finally {
      this.restarting = false
    }
  }

  // ─── Stop ──────────────────────────────────────────────────
  async stop(): Promise<void> {
    const p = this.proc
    if (!p) return
    this.intentionalStop = true
    return new Promise((resolve) => {
      const finish = () => {
        this.proc = null
        this.intentionalStop = false
        resolve()
      }
      p.once('exit', finish)
      try {
        p.kill('SIGTERM')
        setTimeout(() => {
          if (!p.killed && p.exitCode === null) {
            try { p.kill('SIGKILL') } catch { /* ignore */ }
          }
        }, 3000)
      } catch {
        finish()
      }
    })
  }

  // ─── Log helpers ───────────────────────────────────────────
  protected async writeLog(line: string): Promise<void> {
    try { await writeFileAsync(this.logPath(), line + '\n', { flag: 'a' }) } catch { /* ignore */ }
  }
  protected async writeLogMarker(line: string): Promise<void> {
    try { await writeFileAsync(this.logPath(), '\n' + line + '\n', { flag: 'a' }) } catch { /* ignore */ }
  }

  async tailLog(lines: number): Promise<string[]> {
    const max = Math.max(10, Math.min(lines, 1000))
    if (!existsSync(this.logPath())) return []
    const data = await readFileAsync(this.logPath(), 'utf-8').catch(() => '')
    const all = data.split('\n')
    return all.slice(Math.max(0, all.length - max)).filter((l) => l.length > 0)
  }
}
