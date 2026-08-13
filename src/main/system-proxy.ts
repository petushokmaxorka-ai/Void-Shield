// ═══════════════════════════════════════════════════════════
// VOID-SHIELD — OS system proxy (Windows WinINET + Linux GNOME)
// ═══════════════════════════════════════════════════════════
// SOCKS alone does not capture Chrome/Edge/Facebook. HAPP/FlClash use TUN
// or system proxy. When TUN is off (no admin / no setcap), set the user
// proxy so browsers work. Games/UDP still need TUN.

import { execFileSync } from 'child_process'

const WIN_INET_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

function regAdd(args: string[]): void {
  execFileSync('reg', ['add', WIN_INET_KEY, ...args], {
    encoding: 'utf-8',
    timeout: 8000,
    windowsHide: true,
  })
}

/** Refresh WinINET so browsers pick up proxy without restart. */
function notifyWinInetChanged(): void {
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Add-Type -Namespace WinINet -Name Native -MemberDefinition '[DllImport(\"wininet.dll\", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);';" +
          '[void][WinINet.Native]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0);' +
          '[void][WinINet.Native]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0);',
      ],
      { encoding: 'utf-8', timeout: 15000, windowsHide: true }
    )
  } catch {
    /* registry update still applied */
  }
}

function applyWinInet(httpHost: string, httpPort: number): void {
  const server = `${httpHost}:${httpPort}`
  regAdd(['/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f'])
  regAdd(['/v', 'ProxyServer', '/t', 'REG_SZ', '/d', server, '/f'])
  regAdd([
    '/v', 'ProxyOverride', '/t', 'REG_SZ',
    '/d', 'localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.2*;172.3*;192.168.*;<local>',
    '/f',
  ])
  notifyWinInetChanged()
}

function clearWinInet(): void {
  try {
    regAdd(['/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f'])
    notifyWinInetChanged()
  } catch {
    /* ignore */
  }
}

function gsettings(args: string[]): void {
  execFileSync('gsettings', args, { encoding: 'utf-8', timeout: 5000 })
}

/** GNOME / Cinnamon / Budgie use org.gnome.system.proxy. No-op if missing. */
function applyGnomeProxy(host: string, httpPort: number, socksPort: number): void {
  gsettings(['set', 'org.gnome.system.proxy', 'mode', 'manual'])
  gsettings(['set', 'org.gnome.system.proxy.http', 'enabled', 'true'])
  gsettings(['set', 'org.gnome.system.proxy.http', 'host', host])
  gsettings(['set', 'org.gnome.system.proxy.http', 'port', String(httpPort)])
  gsettings(['set', 'org.gnome.system.proxy.https', 'host', host])
  gsettings(['set', 'org.gnome.system.proxy.https', 'port', String(httpPort)])
  gsettings(['set', 'org.gnome.system.proxy.socks', 'host', host])
  gsettings(['set', 'org.gnome.system.proxy.socks', 'port', String(socksPort)])
  gsettings([
    'set', 'org.gnome.system.proxy', 'ignore-hosts',
    "['localhost','127.0.0.0/8','::1','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16']",
  ])
}

function clearGnomeProxy(): void {
  try {
    gsettings(['set', 'org.gnome.system.proxy', 'mode', 'none'])
  } catch {
    /* ignore */
  }
}

/**
 * Point OS user proxy at local HTTP (and SOCKS on Linux).
 * No-op on platforms without a supported desktop proxy API.
 */
export function applySystemProxy(httpHost: string, httpPort: number, socksPort?: number): void {
  if (process.platform === 'win32') {
    applyWinInet(httpHost, httpPort)
    return
  }
  if (process.platform === 'linux') {
    try {
      applyGnomeProxy(httpHost, httpPort, socksPort ?? httpPort)
    } catch {
      /* no gsettings / not GNOME — TUN or per-app proxy still apply */
    }
  }
}

/** Disable OS user proxy. */
export function clearSystemProxy(): void {
  if (process.platform === 'win32') {
    clearWinInet()
    return
  }
  if (process.platform === 'linux') {
    clearGnomeProxy()
  }
}
