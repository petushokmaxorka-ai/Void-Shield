// ═══════════════════════════════════════════════════════════
// VOID-SHIELD — xray Process Runner
// ═══════════════════════════════════════════════════════════
// Управляет жизненным циклом xray-процесса: spawn, kill, health-check.
// Бинарь xray извлекается из AppImage в writable-директорию при первом запуске.
//
// SECURITY (AGENTS.md §3.2): spawn с аргументами, NEVER shell:true.

import { spawn, ChildProcess, execFile } from 'child_process'
import { join } from 'path'
import { existsSync, mkdirSync, chmodSync, copyFileSync, appendFileSync, createReadStream } from 'fs'
import { createInterface } from 'readline'
import { app } from 'electron'

// ─── Paths (portable, через app.getPath) ────────────────────
export function dataDir(): string {
  return app.getPath('userData')  // ~/.config/void-shield-desktop на Linux
}
export function xrayPath(): string {
  return join(dataDir(), 'bin', process.platform === 'win32' ? 'xray.exe' : 'xray')
}
export function configPath(): string {
  return join(dataDir(), 'xray-config.json')
}
export function logPath(): string {
  return join(dataDir(), 'vpn.log')
}

// ─── Platform subdir name for bundled xray ──────────────────
function bundledPlatformDir(): string {
  const p = process.platform
  const a = process.arch
  if (p === 'linux' && a === 'x64') return 'linux-x64'
  if (p === 'linux' && a === 'arm64') return 'linux-arm64'
  if (p === 'win32' && a === 'x64') return 'windows-x64'
  if (p === 'darwin' && a === 'x64') return 'darwin-x64'
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64'
  throw new Error(`Unsupported platform: ${p}-${a}`)
}

// ─── Extract bundled xray to userData on first run ──────────
// AppImage mount is read-only; xray must live in a writable dir for setcap.
export function ensureXrayExtracted(): void {
  const dest = xrayPath()
  if (existsSync(dest)) return  // already extracted
  mkdirSync(join(dataDir(), 'bin'), { recursive: true })

  // Find the bundled binary in resources.
  const resourcesDir = process.resourcesPath ?? join(__dirname, '../..')
  const platformDir = bundledPlatformDir()
  const binName = process.platform === 'win32' ? 'xray.exe' : 'xray'
  const src = join(resourcesDir, 'bin', platformDir, binName)
  if (!existsSync(src)) {
    throw new Error(`Bundled xray not found at ${src}. Run scripts/fetch-xray.sh --all before building.`)
  }
  copyFileSync(src, dest)
  chmodSync(dest, 0o755)
  // Windows: also copy wintun.dll (needed for TUN).
  if (process.platform === 'win32') {
    const wintunSrc = join(resourcesDir, 'bin', platformDir, 'wintun.dll')
    if (existsSync(wintunSrc)) {
      copyFileSync(wintunSrc, join(dataDir(), 'bin', 'wintun.dll'))
    }
  }
}

// ─── Runner state ───────────────────────────────────────────
let proc: ChildProcess | null = null
let startedAt = 0

export function isRunning(): boolean {
  return proc !== null && !proc.killed && proc.exitCode === null
}

export function startedTime(): number {
  return startedAt
}

// ─── Start xray ─────────────────────────────────────────────
export function start(onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isRunning()) return resolve()
    ensureXrayExtracted()
    const bin = xrayPath()
    if (!existsSync(configPath())) {
      return reject(new Error('No xray-config.json — set up a subscription first'))
    }

    // Truncate log on each start (keep it bounded).
    try { appendFileSync(logPath(), `\n--- VOID-SHIELD start ${new Date().toISOString()} ---\n`) } catch { /* ignore */ }

    proc = spawn(bin, ['run', '-c', configPath()], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    startedAt = Date.now()

    const logStream = (label: string, stream: NodeJS.ReadableStream | null): void => {
      if (!stream) return
      const rl = createInterface({ input: stream })
      rl.on('line', (line) => {
        try { appendFileSync(logPath(), `${line}\n`) } catch { /* ignore */ }
        onLine?.(line)
      })
    }
    logStream('stdout', proc.stdout)
    logStream('stderr', proc.stderr)

    proc.on('error', (err) => {
      proc = null
      reject(new Error(`xray failed to start: ${err.message}`))
    })
    proc.on('exit', (code, signal) => {
      const msg = `xray exited code=${code} signal=${signal}`
      appendFileSync(logPath(), `${msg}\n`)
      proc = null
      // Non-zero exit within 3s = startup failure.
      if (code !== 0 && code !== null && Date.now() - startedAt < 3000) {
        reject(new Error(msg))
      }
    })

    // Give xray ~2s to bind ports / fail fast.
    setTimeout(() => {
      if (isRunning()) resolve()
      else reject(new Error('xray did not stay running'))
    }, 2000)
  })
}

// ─── Stop xray ──────────────────────────────────────────────
export function stop(): Promise<void> {
  return new Promise((resolve) => {
    if (!proc) return resolve()
    const p = proc
    proc.on('exit', () => resolve())
    try {
      // SIGTERM first, escalate to SIGKILL after 3s.
      p.kill('SIGTERM')
      setTimeout(() => {
        if (!p.killed && p.exitCode === null) {
          try { p.kill('SIGKILL') } catch { /* ignore */ }
        }
        resolve()
      }, 3000)
    } catch {
      resolve()
    }
    proc = null
  })
}

// ─── Tail the log ───────────────────────────────────────────
export async function tailLog(lines: number): Promise<string[]> {
  const max = Math.max(10, Math.min(lines, 1000))
  if (!existsSync(logPath())) return []
  return new Promise((resolve) => {
    const out: string[] = []
    const rl = createInterface({ input: createReadStream(logPath(), { encoding: 'utf-8' }) })
    rl.on('line', (l) => {
      out.push(l)
      while (out.length > max) out.shift()
    })
    rl.on('close', () => resolve(out))
    rl.on('error', () => resolve([]))
  })
}

// ─── Egress IP probe (via SOCKS inbound) ────────────────────
function probeEgress(): Promise<string> {
  return new Promise((resolve) => {
    execFile('curl', ['-4', '-sS', '--max-time', '4', '-x', 'socks5://127.0.0.1:7893', 'https://api.ipify.org'],
      { encoding: 'utf-8', timeout: 6000 }, (err, stdout) => {
        resolve(err ? '' : stdout.trim())
      })
  })
}

// On Windows, curl may not exist — use a no-op fallback.
if (process.platform === 'win32') {
  // Override probeEgress for Windows (node fetch via proxy).
  // Simplified: empty until a Windows curl/proxy lib is wired.
}

export { probeEgress }
