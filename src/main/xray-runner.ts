// ═══════════════════════════════════════════════════════════
// VOID-SHIELD — xray Process Runner
// ═══════════════════════════════════════════════════════════
// CoreRunner specialization for xray-core (gRPC API + mixed SOCKS inbound).

import net from 'net'
import { execFile } from 'child_process'
import { join } from 'path'
import { CoreRunner } from './core-runner'
import { XRAY_GRPC_HOST, XRAY_SOCKS_HOST, XRAY_SOCKS_PORT, XRAY_SOCKS_PROXY } from './xray-constants'
import * as grpc from './grpc-client'

export class XrayRunner extends CoreRunner {
  readonly name = 'xray'

  // Keep legacy log filename (vpn.log) — users tail this path.
  logPath(): string {
    return join(this.dataDir(), 'vpn.log')
  }

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
    return process.platform === 'win32' ? 'xray.exe' : 'xray'
  }

  protected runArgs(): string[] {
    return ['run', '-c', this.configPath()]
  }

  /** Poll SOCKS port + gRPC API (up to ~5s). */
  protected async readyProbe(): Promise<boolean> {
    for (let i = 0; i < 25; i++) {
      if (!this.isRunning()) return false
      if (await socksPortOpen()) return true
      await new Promise((r) => setTimeout(r, 200))
    }
    return false
  }

  async apiOk(): Promise<boolean> {
    try {
      const bi = await grpc.getBalancerInfo()
      return bi.ok
    } catch {
      return false
    }
  }

  async tunUp(): Promise<boolean> {
    if (process.platform === 'linux') {
      return new Promise((resolve) => {
        execFile('ip', ['link', 'show', 'xray0'], { timeout: 2000 }, (err, stdout) => {
          resolve(!err && stdout.includes('xray0'))
        })
      })
    }
    if (process.platform === 'win32') {
      return new Promise((resolve) => {
        execFile('netsh', ['interface', 'show', 'interface'], { encoding: 'utf-8', timeout: 3000 }, (err, stdout) => {
          resolve(!err && /xray/i.test(stdout))
        })
      })
    }
    return false
  }
}

let _runner: XrayRunner | null = null
function runner(): XrayRunner {
  if (!_runner) _runner = new XrayRunner()
  return _runner
}

function socksPortOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: XRAY_SOCKS_HOST, port: XRAY_SOCKS_PORT })
    const done = (ok: boolean) => {
      sock.removeAllListeners()
      try { sock.destroy() } catch { /* ignore */ }
      resolve(ok)
    }
    sock.setTimeout(600)
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.once('timeout', () => done(false))
  })
}

export function ensureXrayExtracted(): void {
  runner().ensureExtracted()
}

export function xrayPath(): string {
  return runner().binaryPath()
}

export function configPath(): string {
  return runner().configPath()
}

export function logPath(): string {
  return runner().logPath()
}

export function isRunning(): boolean {
  return runner().isRunning()
}

export function startedTime(): number {
  return runner().startedTime()
}

export function start(onLine?: (line: string) => void): Promise<void> {
  void onLine // legacy callback unused — logs go to vpn.log
  return runner().start()
}

export function stop(): Promise<void> {
  return runner().stop()
}

export function tailLog(lines: number): Promise<string[]> {
  return runner().tailLog(lines)
}

export function probeEgress(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'curl',
      ['-4', '-sS', '--max-time', '4', '-x', XRAY_SOCKS_PROXY, 'https://api.ipify.org'],
      { encoding: 'utf-8', timeout: 6000 },
      (err, stdout) => resolve(err ? '' : stdout.trim())
    )
  })
}

export async function socksOk(): Promise<boolean> {
  if (!isRunning()) return false
  if (await socksPortOpen()) return true
  return Boolean(await probeEgress())
}

export async function tunOk(): Promise<boolean> {
  if (!isRunning()) return false
  return runner().tunUp()
}

export async function grpcOk(): Promise<boolean> {
  if (!isRunning()) return false
  return runner().apiOk()
}
