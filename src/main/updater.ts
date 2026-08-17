// ═══════════════════════════════════════════════════════════
// VOID-SHIELD — Auto-Update (electron-updater → GitHub Releases)
// ═══════════════════════════════════════════════════════════
// Delayed startup check + every 6h against the publish feed
// (provider github: petushokmaxorka-ai/Void-Shield — see package.json).
// Silent download; applies on quit (autoInstallOnAppQuit default).
// Dev builds skip — no feed, no APPIMAGE env.

import { app, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC_CHANNELS } from '../shared/types'

const CHECK_DELAY_MS = 15_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const PROGRESS_STEP_PCT = 25

export function initUpdater(broadcast: (line: string) => void): void {
  if (!app.isPackaged) {
    broadcast('[update] dev build — auto-update disabled')
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => broadcast('[update] checking for updates...'))
  autoUpdater.on('update-available', (i) => broadcast(`[update] v${i.version} available — downloading...`))
  autoUpdater.on('update-not-available', () => broadcast('[update] up to date'))
  autoUpdater.on('update-downloaded', (i) => {
    broadcast(`[update] v${i.version} ready — restart to apply (auto-installs on quit)`)
  })
  autoUpdater.on('error', (e) => broadcast(`[update] error: ${e.message}`))

  // Throttle: one log line per PROGRESS_STEP_PCT, not per progress event.
  let lastReported = 0
  autoUpdater.on('download-progress', (p) => {
    const pct = Math.floor(p.percent)
    if (pct - lastReported >= PROGRESS_STEP_PCT || pct >= 100) {
      lastReported = pct
      const mb = (n: number): string => (n / 1048576).toFixed(1)
      broadcast(`[update] downloading ${pct}% (${mb(p.transferred)}/${mb(p.total)} MB)`)
    }
  })

  // One-click restart into the freshly downloaded version.
  ipcMain.handle(IPC_CHANNELS.VPN_UPDATE_RESTART, () => {
    autoUpdater.quitAndInstall()
  })

  const check = (): void => {
    autoUpdater.checkForUpdates().catch(() => {
      // network/feed failures already surface via the 'error' event
    })
  }
  setTimeout(check, CHECK_DELAY_MS).unref()
  setInterval(check, CHECK_INTERVAL_MS).unref()
}
