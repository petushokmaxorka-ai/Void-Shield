// ═══════════════════════════════════════════════════════════
// VOID-SHIELD — OS system proxy (Windows WinINET)
// ═══════════════════════════════════════════════════════════
// SOCKS alone does not capture Chrome/Edge/Facebook on Windows.
// HAPP/FlClash use TUN or system proxy — we set WinINET when TUN is off.

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

/** Point Windows user proxy at local HTTP inbound. No-op off Windows. */
export function applySystemProxy(httpHost: string, httpPort: number): void {
  if (process.platform !== 'win32') return
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

/** Disable Windows user proxy. No-op off Windows. */
export function clearSystemProxy(): void {
  if (process.platform !== 'win32') return
  try {
    regAdd(['/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f'])
    notifyWinInetChanged()
  } catch {
    /* ignore */
  }
}
