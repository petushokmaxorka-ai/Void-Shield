// ═══════════════════════════════════════════════════════════
// VOID-SHIELD DESKTOP — Shared Types & IPC Channels
// ═══════════════════════════════════════════════════════════
// Single source of truth for IPC channel names + data shapes.

/** IPC channel names — never inline strings. */
export const IPC_CHANNELS = {
  // Onboarding / settings
  VPN_GET_STATE: 'vpn:get-state',
  VPN_GET_SETTINGS: 'vpn:get-settings',
  VPN_UPDATE_SUBSCRIPTION: 'vpn:update-subscription',
  VPN_GRANT_CAPS: 'vpn:grant-caps',
  // Lifecycle
  VPN_START: 'vpn:start',
  VPN_STOP: 'vpn:stop',
  VPN_RESTART: 'vpn:restart',
  VPN_IS_RUNNING: 'vpn:is-running',
  // Status / data
  VPN_STATUS: 'vpn:status',
  VPN_NODES: 'vpn:nodes',
  VPN_SELECT: 'vpn:select',
  VPN_AUTO: 'vpn:auto',
  VPN_TRAFFIC: 'vpn:traffic',
  VPN_LOGS: 'vpn:logs',
  // Phase 3: scenario + core switching, batch delay test, quota, clipboard import
  VPN_SWITCH_SCENARIO: 'vpn:switch-scenario',
  VPN_SWITCH_CORE: 'vpn:switch-core',
  VPN_GET_CORE: 'vpn:get-core',
  VPN_TEST_DELAYS: 'vpn:test-delays',
  VPN_GET_QUOTA: 'vpn:get-quota',
  VPN_IMPORT_CLIPBOARD: 'vpn:import-clipboard',
  VPN_CHECK_CLIPBOARD: 'vpn:check-clipboard',
  VPN_IMPORT_FILE: 'vpn:import-file',
  VPN_IMPORT_FLCLASH: 'vpn:import-flclash',
  VPN_SET_CUSTOM_UA: 'vpn:set-custom-ua',
  // Phase 4: real-time log stream (main → renderer push via clash-api WS bridge)
  VPN_LOG_EVENT: 'vpn:log-event'
} as const

// ─── Data shapes ────────────────────────────────────────────

export interface VpnStatus {
  running: boolean
  uptime: number
  egressIp: string
  activeNode: string
  override: string
  autoMode: boolean
  apiOk: boolean
  socksOk: boolean
  tunOk: boolean
}

export interface VpnNode {
  tag: string
  server: string
  port: number
  alive: boolean | null
  delayMs: number | null
  lastError: string
}

export interface NodesResponse {
  nodes: VpnNode[]
  total: number
  alive: number
}

export interface TrafficData {
  inboundUp: number
  inboundDown: number
  uptime: number
  goroutines: number
  allocBytes: number
  error?: string
}

export interface AppSettings {
  subscriptionUrlEnc: string
  capsGranted: boolean
  lastUpdate: number
  version: 1
}

export interface AppState {
  hasSubscription: boolean
  capsGranted: boolean
  needsCaps: boolean
}

export interface SubscriptionUpdateResult {
  nodes: number
  format: string
}
