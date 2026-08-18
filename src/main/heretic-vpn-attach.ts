// When HereticArch dashboard VPN exists, VOID-SHIELD desktop drives
// heretic-vpn.service (127.0.0.1:7890 / :8086) instead of a second dead xray.

import { execFile, execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import net from 'net'

const execFileAsync = promisify(execFile)

export const HERETIC_VPN_UNIT = 'heretic-vpn.service'
export const HERETIC_VPN_CONFIG = join(homedir(), '.config', 'heretic-vpn', 'config.json')
export const HERETIC_VPN_LOG = join(homedir(), '.config', 'heretic-vpn', 'vpn.log')
export const HERETIC_VPN_BUILD = join(homedir(), '.config', 'heretic-vpn', 'build-config.py')
export const HERETIC_VPN_PROFILE = join(homedir(), '.config', 'heretic-vpn', 'profile.flclashx-71.yaml')
export const HERETIC_VPN_GRPC = '127.0.0.1:8086'
export const HERETIC_VPN_SOCKS_HOST = '127.0.0.1'
export const HERETIC_VPN_SOCKS_PORT = 7890

export function usingHereticVpn(): boolean {
  return process.platform === 'linux' && existsSync(HERETIC_VPN_CONFIG)
}

export function hereticVpnActiveSync(): boolean {
  try {
    const out = execFileSync('systemctl', ['--user', 'is-active', HERETIC_VPN_UNIT], {
      timeout: 3000,
      encoding: 'utf-8',
    })
    return String(out).trim() === 'active'
  } catch {
    return false
  }
}

export async function hereticVpnCtl(action: 'start' | 'stop' | 'restart'): Promise<void> {
  await execFileAsync('systemctl', ['--user', action, HERETIC_VPN_UNIT], { timeout: 20000 })
}

export function rebuildHereticVpn(yamlPath: string): void {
  if (!existsSync(HERETIC_VPN_BUILD)) {
    throw new Error(`Missing ${HERETIC_VPN_BUILD}`)
  }
  execFileSync('python3', [HERETIC_VPN_BUILD, yamlPath], {
    timeout: 60000,
    encoding: 'utf-8',
  })
}

export function hereticSocksOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: HERETIC_VPN_SOCKS_HOST, port: HERETIC_VPN_SOCKS_PORT })
    const done = (ok: boolean): void => {
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

export async function waitHereticSocks(ms = 10000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await hereticSocksOpen()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

export function probeHereticEgress(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'curl',
      ['-4', '-sS', '--max-time', '4', '--noproxy', '*',
        '--socks5-hostname', `${HERETIC_VPN_SOCKS_HOST}:${HERETIC_VPN_SOCKS_PORT}`,
        'https://api.ipify.org'],
      { encoding: 'utf-8', timeout: 6000 },
      (err, stdout) => resolve(err ? '' : stdout.trim())
    )
  })
}
