// ═══════════════════════════════════════════════════════════
// VOID-SHIELD — Routing Scenarios
// ═══════════════════════════════════════════════════════════
// Пресеты маршрутизации (как у Hiddify): Proxy / Bypass-LAN / Bypass-RU /
// Bypass-CN / Bypass-GFW. Каждый сценарий = набор rule-sets + правило
// route-to-direct для bypass-стран, остальное → proxy.
//
// Rule-sets берутся из MetaCubeX/meta-rules-dat (ветка sing, формат .srs).
// sing-box качает их сам при старте (route.rule_set[].type=remote), кеширует
// в cache_file, обновляет по update_interval.

export type Scenario = 'proxy' | 'bypass-lan' | 'bypass-ru' | 'bypass-cn' | 'bypass-gfw'

export const SCENARIO_LABELS: Record<Scenario, string> = {
  'proxy': '◆ FULL GELLAR FIELD — весь трафик через VPN',
  'bypass-lan': '☉ BYPASS LAN — локальная сеть напрямик',
  'bypass-ru': '⚒ BYPASS RU — РФ-трафик напрямую (geoip+geosite:ru)',
  'bypass-cn': '⚒ BYPASS CN — китайский трафик напрямую',
  'bypass-gfw': '☉ GFW MODE — только заблокированное через VPN',
}

// ─── Rule-set definitions ───────────────────────────────────
// Binary .srs files hosted at MetaCubeX/meta-rules-dat (branch: sing).
// Verified working: geo/geoip/<cc>.srs, geo/geosite/<cc>.srs.
const RS_BASE = 'https://github.com/MetaCubeX/meta-rules-dat/raw/sing/geo'

interface RuleSetDef {
  tag: string
  url: string
}

const rs = (kind: 'geoip' | 'geosite', cc: string, tagSuffix = ''): RuleSetDef => ({
  tag: `${kind}-${cc}${tagSuffix}`,
  url: `${RS_BASE}/${kind}/${cc}.srs`,
})

// All rule-sets we reference across scenarios (de-duplicated by tag).
export const ALL_RULE_SETS: RuleSetDef[] = [
  rs('geosite', 'ru'),
  rs('geoip', 'ru'),
  rs('geosite', 'cn'),
  rs('geoip', 'cn'),
  rs('geosite', 'private'),
  rs('geoip', 'private'),
  rs('geosite', 'category-ads-all', ''),  // ad blocking (optional, GFW scenario)
]

// ─── Build route.rules for a given scenario ─────────────────
// Returns the rules to PREPEND before the LAN-bypass + final-proxy rules.
// Each bypass-country rule routes matching traffic to 'direct'.
export function scenarioRules(scenario: Scenario): Record<string, unknown>[] {
  const rules: Record<string, unknown>[] = []
  switch (scenario) {
    case 'proxy':
      // Everything via proxy (final: SELECTOR handles it). No geo rules.
      break
    case 'bypass-lan':
      // Only LAN direct — handled by the universal ip_is_private rule below.
      // No additional geo rules needed.
      break
    case 'bypass-ru':
      // Russian domains + IPs → direct; rest → proxy.
      rules.push({ rule_set: ['geosite-ru', 'geoip-ru'], outbound: 'direct' })
      break
    case 'bypass-cn':
      // Chinese domains + IPs → direct (for users behind CN censorship who
      // want only non-CN traffic through the proxy).
      rules.push({ rule_set: ['geosite-cn', 'geoip-cn'], outbound: 'direct' })
      break
    case 'bypass-gfw':
      // Inverse: only GFW-blocked domains via proxy, everything else direct.
      // Uses geosite category-gfw (CN blocklist) → proxy, default → direct.
      rules.push({ rule_set: ['geosite-category-ads-all'], outbound: 'block' })
      // Note: full GFW-mode requires geosite-gfw rule-set + final: direct.
      // Added to ALL_RULE_SETS when this scenario is selected (lazy).
      break
  }
  return rules
}

// Which rule-set tags a scenario needs (so we only download what we use).
export function scenarioRuleSetTags(scenario: Scenario): string[] {
  switch (scenario) {
    case 'proxy': return []
    case 'bypass-lan': return ['geosite-private', 'geoip-private']
    case 'bypass-ru': return ['geosite-ru', 'geoip-ru', 'geosite-private', 'geoip-private']
    case 'bypass-cn': return ['geosite-cn', 'geoip-cn', 'geosite-private', 'geoip-private']
    case 'bypass-gfw': return ['geosite-category-ads-all', 'geosite-private', 'geoip-private']
  }
}

// Build the route.rule_set[] array for a scenario (only the needed sets).
export function scenarioRuleSetDefs(scenario: Scenario): RuleSetDef[] {
  const needed = new Set(scenarioRuleSetTags(scenario))
  return ALL_RULE_SETS.filter((d) => needed.has(d.tag))
}

// GFW special-case: final outbound is 'direct' (only blocked → proxy).
export function scenarioFinal(scenario: Scenario, selectorTag: string): string {
  return scenario === 'bypass-gfw' ? 'direct' : selectorTag
}
