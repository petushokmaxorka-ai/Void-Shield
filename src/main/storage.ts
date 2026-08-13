// ═══════════════════════════════════════════════════════════
// VOID-SHIELD — Settings Storage (H6 fix: encrypted subscriptionUrl)
// ═══════════════════════════════════════════════════════════
// Хранит настройки в userData/settings.json.
// subscriptionUrl шифруется через safeStorage API Electron.
// Это безопасное OS-level шифрование (Keychain на macOS, DPAPI на Windows, libsecret на Linux).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app, safeStorage } from 'electron'

export interface SubscriptionQuota {
  upload: number
  download: number
  total: number        // 0 = unlimited
  expire: number       // 0 = never; unix seconds
}

export type CoreEngine = 'singbox' | 'xray'
export type RoutingScenario = 'proxy' | 'bypass-lan' | 'bypass-ru' | 'bypass-cn' | 'bypass-gfw'

export interface Settings {
  // Encrypted base64 string (safeStorage.encryptString). Empty string = no subscription.
  // Decrypted on load via getSubscriptionUrl().
  subscriptionUrlEnc: string
  capsGranted: boolean
  /**
   * System-wide TUN for xray/sing-box. Default false — SOCKS/mixed only
   * (reliable ignition on Windows without admin). Set true after Linux setcap.
   */
  enableTun: boolean
  lastUpdate: number
  workingUserAgent: string
  /** Optional override tried first when fetching subscriptions (Remnawave / panel UA). */
  customUserAgent: string
  quota: SubscriptionQuota | null
  core: CoreEngine
  scenario: RoutingScenario
  autoUpdateHours: number
  version: number
}

const DEFAULT: Settings = {
  subscriptionUrlEnc: '',
  capsGranted: false,
  enableTun: false,
  lastUpdate: 0,
  workingUserAgent: '',
  customUserAgent: '',
  quota: null,
  core: 'xray',
  scenario: 'proxy',
  autoUpdateHours: 24,
  version: 7,
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/// Encrypt a plaintext string using Electron safeStorage.
/// Returns base64-encoded encrypted string, or empty string if encryption unavailable.
export function encryptSubscriptionUrl(plaintext: string): string {
  if (!plaintext) return ''
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[storage] safeStorage not available — storing plaintext (fallback)')
    return Buffer.from(plaintext).toString('base64')
  }
  const encrypted = safeStorage.encryptString(plaintext)
  return encrypted.toString('base64')
}

/// Decrypt a base64-encoded encrypted string back to plaintext.
/// Returns empty string if input is empty or decryption fails.
export function decryptSubscriptionUrl(encBase64: string): string {
  if (!encBase64) return ''
  try {
    const buf = Buffer.from(encBase64, 'base64')
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf)
    }
    // Fallback: was stored as plain base64 (no safeStorage)
    return buf.toString('utf-8')
  } catch (e) {
    console.error('[storage] Failed to decrypt subscriptionUrl:', e)
    return ''
  }
}

/// Get the plaintext subscription URL from settings.
export function getSubscriptionUrl(s: Settings): string {
  return decryptSubscriptionUrl(s.subscriptionUrlEnc)
}

export function loadSettings(): Settings {
  const p = settingsPath()
  if (!existsSync(p)) return { ...DEFAULT }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>

    // Migration v4→v5: move plaintext subscriptionUrl → encrypted
    if (raw.subscriptionUrl && typeof raw.subscriptionUrl === 'string' && raw.subscriptionUrl.length > 0) {
      console.log('[storage] Migrating v4→v5: encrypting subscriptionUrl')
      raw.subscriptionUrlEnc = encryptSubscriptionUrl(raw.subscriptionUrl)
      delete raw.subscriptionUrl
    }

    // Migration v6→v7: enableTun (default false). Linux users who already
    // granted setcap keep system-wide TUN; Windows stays SOCKS-only.
    if (raw.enableTun === undefined && process.platform === 'linux' && raw.capsGranted === true) {
      raw.enableTun = true
    }

    return { ...DEFAULT, ...raw, version: DEFAULT.version }
  } catch {
    return { ...DEFAULT }
  }
}

export function saveSettings(s: Settings): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2))
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...patch }
  saveSettings(next)
  return next
}

/// Set subscription URL — encrypts before saving.
export function setSubscriptionUrl(url: string): Settings {
  return updateSettings({ subscriptionUrlEnc: encryptSubscriptionUrl(url) })
}
