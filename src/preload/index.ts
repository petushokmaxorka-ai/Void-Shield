// ═══════════════════════════════════════════════════════════
// VOID-SHIELD DESKTOP — Preload (Context Bridge)
// ═══════════════════════════════════════════════════════════
// Exposes the VPN API to the renderer via contextBridge.

import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types'

const electronAPI = {
  vpn: {
    // Onboarding / settings
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.VPN_GET_STATE),
    getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.VPN_GET_SETTINGS),
    updateSubscription: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.VPN_UPDATE_SUBSCRIPTION, url),
    grantCapabilities: () => ipcRenderer.invoke(IPC_CHANNELS.VPN_GRANT_CAPS),
    // Lifecycle
    start: () => ipcRenderer.invoke(IPC_CHANNELS.VPN_START),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.VPN_STOP),
    restart: () => ipcRenderer.invoke(IPC_CHANNELS.VPN_RESTART),
    isRunning: () => ipcRenderer.invoke(IPC_CHANNELS.VPN_IS_RUNNING),
    // Status / data
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.VPN_STATUS),
    getNodes: () => ipcRenderer.invoke(IPC_CHANNELS.VPN_NODES),
    selectNode: (tag: string) => ipcRenderer.invoke(IPC_CHANNELS.VPN_SELECT, tag),
    autoSelect: () => ipcRenderer.invoke(IPC_CHANNELS.VPN_AUTO),
    getTraffic: () => ipcRenderer.invoke(IPC_CHANNELS.VPN_TRAFFIC),
    getLogs: (lines = 200) => ipcRenderer.invoke(IPC_CHANNELS.VPN_LOGS, lines),
    // Phase 3: scenario + core switching, batch delay test, quota, clipboard
    switchScenario: (scenario: string) => ipcRenderer.invoke(IPC_CHANNELS.VPN_SWITCH_SCENARIO, scenario),
    switchCore: (core: string) => ipcRenderer.invoke(IPC_CHANNELS.VPN_SWITCH_CORE, core),
    getCore: () => ipcRenderer.invoke(IPC_CHANNELS.VPN_GET_CORE),
    testDelays: () => ipcRenderer.invoke(IPC_CHANNELS.VPN_TEST_DELAYS),
    getQuota: () => ipcRenderer.invoke(IPC_CHANNELS.VPN_GET_QUOTA),
    importFromText: (text: string) => ipcRenderer.invoke(IPC_CHANNELS.VPN_IMPORT_CLIPBOARD, text),
    importFromFile: () => ipcRenderer.invoke(IPC_CHANNELS.VPN_IMPORT_FILE),
    importFromFlClash: (preferredUrl?: string) => ipcRenderer.invoke(IPC_CHANNELS.VPN_IMPORT_FLCLASH, preferredUrl),
    setCustomUserAgent: (ua: string) => ipcRenderer.invoke(IPC_CHANNELS.VPN_SET_CUSTOM_UA, ua),
    checkClipboardForLink: () => ipcRenderer.invoke(IPC_CHANNELS.VPN_CHECK_CLIPBOARD),
    // Phase 4: real-time log stream (main → renderer push).
    onLogEvent: (cb: (line: string) => void) => {
      const handler = (_e: unknown, line: string): void => cb(line)
      ipcRenderer.on(IPC_CHANNELS.VPN_LOG_EVENT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VPN_LOG_EVENT, handler)
    },
    // Phase 5: deep-link import (void-shield://import?url=...) pre-fill.
    onImportUrl: (cb: (url: string) => void): void => {
      ipcRenderer.on('void-shield:import-url', (_e, url: string) => cb(url))
    }
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electronAPI', electronAPI)
} else {
  ;(globalThis as unknown as { electronAPI: typeof electronAPI }).electronAPI = electronAPI
}

export type ElectronAPI = typeof electronAPI
