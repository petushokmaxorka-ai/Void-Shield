// ═══════════════════════════════════════════════════════════
// VOID-SHIELD — TUN Capabilities
// ═══════════════════════════════════════════════════════════
// TUN-режим требует CAP_NET_ADMIN на Linux. На macOS — root. На Windows —
// wintun.dll (бандлится, доп. прав не нужно если запущен как админ).
//
// Подход: одноразовый setcap через pkexec (Linux). Запоминаем в settings.

import { execFileSync } from 'child_process'

export interface CapState {
  needed: boolean        // требуются ли права вообще (false на Windows)
  granted: boolean       // права уже выданы
  needsElevation: boolean // нужно запросить pkexec/root сейчас
}

// ─── Платформа требует capabilities? ────────────────────────
export function platformNeedsCaps(): boolean {
  return process.platform === 'linux' || process.platform === 'darwin'
}

// ─── Проверить, есть ли уже CAP_NET_ADMIN у xray (Linux) ────
export function checkCaps(xrayPath: string): CapState {
  if (!platformNeedsCaps()) {
    return { needed: false, granted: true, needsElevation: false }
  }
  if (process.platform === 'linux') {
    try {
      const out = execFileSync('getcap', [xrayPath], { encoding: 'utf-8', timeout: 3000 })
      const hasNetAdmin = /cap_net_admin/.test(out)
      return { needed: true, granted: hasNetAdmin, needsElevation: !hasNetAdmin }
    } catch {
      // getcap недоступен — предполагаем худшее, попросим elevation.
      return { needed: true, granted: false, needsElevation: true }
    }
  }
  // macOS: всегда нужно elevation (запуск через sudo/pkexec).
  return { needed: true, granted: false, needsElevation: true }
}

// ─── Запросить CAP_NET_ADMIN через pkexec (Linux) ───────────
// Возвращает true при успехе. Бросает при ошибке/отмене.
export function grantCapsLinux(xrayPath: string): boolean {
  if (process.platform !== 'linux') return true
  // pkexec setcap 'cap_net_admin,cap_net_bind_service=+ep' /path/to/xray
  execFileSync('pkexec', [
    'setcap', 'cap_net_admin,cap_net_bind_service=+ep', xrayPath
  ], { encoding: 'utf-8', timeout: 30000 })
  // Проверим, что сработало.
  return checkCaps(xrayPath).granted
}
