// ═══════════════════════════════════════════════════════════
// VOID-SHIELD DESKTOP — Main Process Entry
// ═══════════════════════════════════════════════════════════
// Autonomous Electron app: manages an embedded xray-core process
// and exposes a VPN control surface to the renderer via IPC.

import { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { IPC_CHANNELS } from '../shared/types'
import { VpnManager } from './vpn-manager'
import { initUpdater } from './updater'

const vpn = new VpnManager()
let tray: Tray | null = null
let isQuitting = false

// ─── System tray (Phase 3.3) ────────────────────────────────
// Icon: build from the bundled PNG (extraResources) or a 16x16 fallback.
function trayIconPath(): string {
  // resourcesPath points at the extraResources dir in packaged app.
  const base = process.resourcesPath ?? join(__dirname, '../..')
  // hicolor 256 icon is installed alongside; fall back to build/icon.png.
  return join(base, 'icon.png')
}

function buildTrayMenu(): Menu {
  const running = vpn.isRunning()
  const items: MenuItemConstructorOptions[] = [
    { label: running ? '◆ GELLAR FIELD: ACTIVE' : '✗ GELLAR FIELD: DOWN', enabled: false },
    { type: 'separator' },
    {
      label: running ? 'EXTINGUISH' : 'IGNITE',
      click: () => { void (running ? vpn.stop() : vpn.start()).then(updateTray) }
    },
    {
      label: 'RESTART',
      click: () => { void vpn.restart().then(updateTray) }
    },
    { type: 'separator' },
    {
      label: 'SHOW PANEL',
      click: () => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win) { win.show(); win.focus() }
        else createWindow()
      }
    },
    { type: 'separator' },
    {
      label: 'QUIT',
      click: () => { isQuitting = true; app.quit() }
    }
  ]
  return Menu.buildFromTemplate(items)
}

function updateTray(): void {
  if (!tray) return
  tray.setContextMenu(buildTrayMenu())
  tray.setToolTip(vpn.isRunning() ? 'VOID-SHIELD — Gellar Field active' : 'VOID-SHIELD — offline')
}

function createTray(): void {
  if (tray) return
  tray = new Tray(nativeImage.createFromPath(trayIconPath()))
  tray.setToolTip('VOID-SHIELD')
  tray.setContextMenu(buildTrayMenu())
  // Single click → toggle window visibility (typical tray UX).
  tray.on('click', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) { createWindow(); return }
    if (win.isVisible()) win.hide()
    else { win.show(); win.focus() }
  })
}

function registerIpc(): void {
  // Onboarding / settings
  ipcMain.handle(IPC_CHANNELS.VPN_GET_STATE, () => vpn.getState())
  ipcMain.handle(IPC_CHANNELS.VPN_GET_SETTINGS, () => vpn.getSettings())
  ipcMain.handle(IPC_CHANNELS.VPN_UPDATE_SUBSCRIPTION, (_e, url: string) => vpn.updateSubscription(url))
  ipcMain.handle(IPC_CHANNELS.VPN_GRANT_CAPS, () => {
    try { return { ok: vpn.grantCapabilities() } }
    catch (e) { return { ok: false, error: (e as Error).message } }
  })
  // Lifecycle
  ipcMain.handle(IPC_CHANNELS.VPN_START, async () => {
    try { await vpn.start(); return { ok: true } }
    catch (e) { return { ok: false, error: (e as Error).message } }
  })
  ipcMain.handle(IPC_CHANNELS.VPN_STOP, async () => {
    try { await vpn.stop(); return { ok: true } }
    catch (e) { return { ok: false, error: (e as Error).message } }
  })
  ipcMain.handle(IPC_CHANNELS.VPN_RESTART, async () => {
    try { await vpn.restart(); return { ok: true } }
    catch (e) { return { ok: false, error: (e as Error).message } }
  })
  ipcMain.handle(IPC_CHANNELS.VPN_IS_RUNNING, () => vpn.isRunning())
  // Status / data
  ipcMain.handle(IPC_CHANNELS.VPN_STATUS, () => vpn.getStatus())
  ipcMain.handle(IPC_CHANNELS.VPN_NODES, () => vpn.getNodes())
  ipcMain.handle(IPC_CHANNELS.VPN_SELECT, (_e, tag: string) => vpn.selectNode(tag))
  ipcMain.handle(IPC_CHANNELS.VPN_AUTO, () => vpn.autoSelect())
  ipcMain.handle(IPC_CHANNELS.VPN_TRAFFIC, () => vpn.getTraffic())
  ipcMain.handle(IPC_CHANNELS.VPN_LOGS, (_e, lines = 200) => vpn.getLogs(lines))
  // Phase 3: scenario + core switching, batch delay test, quota, clipboard
  ipcMain.handle(IPC_CHANNELS.VPN_SWITCH_SCENARIO, async (_e, scenario: string) => {
    try { await vpn.switchScenario(scenario); return { ok: true } }
    catch (e) { return { ok: false, error: (e as Error).message } }
  })
  ipcMain.handle(IPC_CHANNELS.VPN_SWITCH_CORE, async (_e, core: string) => {
    try { await vpn.switchCore(core as 'singbox' | 'xray'); return { ok: true } }
    catch (e) { return { ok: false, error: (e as Error).message } }
  })
  ipcMain.handle(IPC_CHANNELS.VPN_GET_CORE, () => vpn.getCore())
  ipcMain.handle(IPC_CHANNELS.VPN_TEST_DELAYS, () => vpn.testDelays())
  ipcMain.handle(IPC_CHANNELS.VPN_GET_QUOTA, () => vpn.getQuota())
  ipcMain.handle(IPC_CHANNELS.VPN_IMPORT_CLIPBOARD, async (_e, text: string) => {
    try { return await vpn.importFromText(text) }
    catch (e) { return { ok: false, error: (e as Error).message } }
  })
  ipcMain.handle(IPC_CHANNELS.VPN_CHECK_CLIPBOARD, () => vpn.checkClipboardForLink())
  ipcMain.handle(IPC_CHANNELS.VPN_IMPORT_FILE, async () => {
    // Native open-file dialog → read → parse via importFromText.
    const { dialog } = await import('electron')
    const res = await dialog.showOpenDialog({
      title: 'Import VPN configuration',
      properties: ['openFile'],
      filters: [
        { name: 'VPN configs', extensions: ['yaml', 'yml', 'json', 'txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePaths.length) return { ok: false, error: 'canceled' }
    try {
      const { readFileSync } = await import('fs')
      const text = readFileSync(res.filePaths[0], 'utf-8')
      return await vpn.importFromText(text)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle(IPC_CHANNELS.VPN_IMPORT_FLCLASH, async (_e, preferredUrl?: string) => {
    try { return await vpn.importFromFlClashX(preferredUrl) }
    catch (e) { return { ok: false, error: (e as Error).message } }
  })
  ipcMain.handle(IPC_CHANNELS.VPN_SET_CUSTOM_UA, (_e, ua: string) => {
    vpn.setCustomUserAgent(ua ?? '')
    return { ok: true }
  })
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 520,
    minHeight: 600,
    show: false,
    backgroundColor: '#050203',
    title: 'VOID-SHIELD',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Close-to-tray: hide instead of quit (VPN survives window close).
  interceptWindowClose(mainWindow)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('dev.heretic-os.void-shield')
  app.on('browser-window-created', (_e, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()
  createWindow()
  createTray()
  // Periodically refresh the tray menu (status changes as VPN starts/stops).
  setInterval(updateTray, 5000)
  // Real-time log bridge: subscribe to sing-box clash-api /logs WebSocket and
  // push lines to the renderer via IPC (sandbox can't reach WS directly).
  startLogBridge()
  // Auto-update (v1.2.0): GitHub Releases feed, startup + 6h cycle.
  initUpdater(broadcastLog)
  // Auto-update subscription on a schedule (Point 4). Only fires if the user
  // has a URL-backed subscription (not file-imported, where URL == '').
  startSubscriptionAutoUpdate()
  // Deep-link handler: void-shield://import?url=... (Point 2). One-click import.
  registerDeepLinkHandler()

  // Pre-seed: if VOID_SHIELD_SUBSCRIPTION env is set and no config exists,
  // auto-register the subscription on launch (skips onboarding UI).
  // Used for testing and unattended deployment.
  const seedUrl = process.env['VOID_SHIELD_SUBSCRIPTION']
  if (seedUrl && !vpn.getState().hasSubscription) {
    console.log('[void-shield] pre-seeding subscription from VOID_SHIELD_SUBSCRIPTION')
    void vpn.updateSubscription(seedUrl).then((r) => {
      console.log(`[void-shield] pre-seeded: ${r.nodes} nodes (${r.format})`)
      // Grant caps if needed, then start.
      if (vpn.getState().needsCaps) {
        try { vpn.grantCapabilities() } catch (e) { console.error('[void-shield] caps grant failed:', e) }
      }
      return vpn.start()
    }).then(() => console.log('[void-shield] auto-ignited'))
      .catch((e) => console.error('[void-shield] pre-seed failed:', e))
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Close-to-tray: closing the window hides it (VPN keeps running in the
// background + tray). Only a real Quit (tray menu / before-quit) tears down.
app.on('window-all-closed', () => {
  // macOS convention: keep app alive. Other platforms: keep alive too while
  // tray exists — VPN shouldn't die because the panel was closed.
  updateTray()
})

app.on('before-quit', () => {
  isQuitting = true
  void vpn.close()
})

// Prevent actual quit on window close button — route to hide instead, unless
// the user explicitly Quit via tray (isQuitting flag).
function interceptWindowClose(win: BrowserWindow): void {
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
      updateTray()
    }
  })
}

// ─── Real-time log bridge (Phase 4.6) ───────────────────────
// sing-box clash-api streams logs over WebSocket at ws://127.0.0.1:9097/logs.
// (9097 = our dedicated clash-api port; 9090 is often taken by mihomo.)
// We subscribe (lazily — only when sing-box is running), parse the JSON
// frames {type, payload}, and push each line to every renderer window via IPC.
// xray-core has no WS API → renderer falls back to polling getLogs() there.
let logWs: WebSocket | null = null
let logBridgeStarted = false

function broadcastLog(line: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.VPN_LOG_EVENT, line)
  }
}

function connectLogWs(): void {
  if (logWs) return
  try {
    logWs = new WebSocket('ws://127.0.0.1:9097/logs?level=warning')
    logWs.onmessage = (ev) => {
      try {
        // clash-api /logs frames: {"type":"warning","payload":"..."}
        const j = JSON.parse(String(ev.data)) as { payload?: string }
        if (j.payload) broadcastLog(j.payload)
      } catch {
        broadcastLog(String(ev.data))
      }
    }
    logWs.onclose = () => { logWs = null }
    logWs.onerror = () => { try { logWs?.close() } catch { /* ignore */ }; logWs = null }
  } catch { /* sing-box not ready / no WS support */ }
}

function startLogBridge(): void {
  if (logBridgeStarted) return
  logBridgeStarted = true
  // Reconnect check every 5s — sing-box may start/stop at any time.
  setInterval(() => {
    if (vpn.isRunning() && vpn.getCore() === 'singbox' && !logWs) {
      connectLogWs()
    } else if ((!vpn.isRunning() || vpn.getCore() !== 'singbox') && logWs) {
      try { logWs.close() } catch { /* ignore */ }
      logWs = null
    }
  }, 5000)
}

// ─── Subscription auto-update (Phase 5 — Point 4) ───────────
// Re-fetches the subscription URL every N hours (from settings.autoUpdateHours).
// Only fires for URL-backed subs (file imports have empty URL). On failure,
// silently keeps the last-good config (no user disruption).
let autoUpdateTimer: NodeJS.Timeout | null = null
function startSubscriptionAutoUpdate(): void {
  if (autoUpdateTimer) clearTimeout(autoUpdateTimer)
  const hours = vpn.getSettings().autoUpdateHours ?? 0
  if (!hours) return  // 0 = manual only
  autoUpdateTimer = setInterval(async () => {
    const subUrl = vpn.getSubscriptionUrl()
    if (!subUrl) return  // file-imported, no URL
    if (!vpn.isRunning()) return    // don't refresh a dead VPN
    console.log('[void-shield] auto-updating subscription...')
    try {
      const r = await vpn.updateSubscription(subUrl)
      console.log(`[void-shield] auto-updated: ${r.nodes} nodes (${r.format})`)
      // Restart the active core to load the refreshed config (rule-sets etc).
      await vpn.restart()
    } catch (e) {
      console.log(`[void-shield] auto-update failed (keeping last config): ${(e as Error).message}`)
    }
  }, hours * 3600 * 1000)
}

// ─── Deep-link handler (Phase 5 — Point 2) ──────────────────
// void-shield://import?url=<encoded-url> → onboarding auto-fills + registers.
// Registered as MimeType x-scheme-handler/void-shield in the .desktop file.
// One-click import from a provider's website (no copy-paste needed).
function registerDeepLinkHandler(): void {
  // macOS/open-url event
  app.on('open-url', (e, url) => {
    e.preventDefault()
    handleDeepLink(url)
  })
  // Linux/Windows: second-instance argv
  const gotTheLock = app.requestSingleInstanceLock()
  if (!gotTheLock) {
    app.quit()
    return
  }
  app.on('second-instance', (_e, argv) => {
    // Focus existing window + handle any deep-link argv.
    const win = BrowserWindow.getAllWindows()[0]
    if (win) { win.show(); win.focus() }
    for (const arg of argv) {
      if (arg.startsWith('void-shield://')) { handleDeepLink(arg); break }
    }
  })
  // Also check argv at launch (cold-start via deep link).
  for (const arg of process.argv) {
    if (arg.startsWith('void-shield://')) { handleDeepLink(arg); break }
  }
}

function handleDeepLink(link: string): void {
  // void-shield://import?url=https%3A%2F%2Fprovider%2Fsub
  try {
    const u = new URL(link)
    if (u.host !== 'import') return
    const targetUrl = u.searchParams.get('url')
    if (!targetUrl) return
    console.log(`[void-shield] deep-link import: ${targetUrl}`)
    // Show the window, fill the field, and let the user confirm/register.
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      win.show()
      win.focus()
      // Send to renderer to pre-fill + auto-register.
      win.webContents.send('void-shield:import-url', targetUrl)
    }
  } catch (e) {
    console.error('[void-shield] deep-link parse failed:', e)
  }
}
