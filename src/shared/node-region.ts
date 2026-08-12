// Domestic vs foreign node tags from subscription display names (emoji + RU labels).

/** Russian domestic exits — fast in RU, no bypass for blocked foreign sites. */
export function isDomesticRuNode(tag: string): boolean {
  const upper = tag.toUpperCase()
  // Explicit foreign-auto pools (not domestic).
  if (upper.includes('АВТОЗАРУБЕЖ') || upper.includes('AUTOFOR') || upper.includes('AUTOFOREIGN')) {
    return false
  }
  if (tag.includes('🇷🇺')) return true
  if (upper.includes('РОССИЯ') || upper.includes('ROSSIA') || upper.includes('RUSSIA')) return true
  // Provider "auto base station" lines are domestic RU relays.
  if (upper.includes('АВТО') && upper.includes('БС')) return true
  return false
}

export interface NodeRosterRow {
  tag: string
  alive: boolean | null
  delayMs: number | null
}

export function hasAliveNonDomesticRu(nodes: NodeRosterRow[]): boolean {
  return nodes.some((n) => n.alive === true && !isDomesticRuNode(n.tag))
}

/** Alive/delay sort; sink domestic RU to bottom when any foreign node is alive. */
export function compareNodesForRoster(
  a: NodeRosterRow,
  b: NodeRosterRow,
  sinkDomestic: boolean
): number {
  if (sinkDomestic) {
    const aDom = isDomesticRuNode(a.tag)
    const bDom = isDomesticRuNode(b.tag)
    if (aDom !== bDom) return aDom ? 1 : -1
  }
  if (a.alive === true) {
    return b.alive === true ? (a.delayMs ?? 99999) - (b.delayMs ?? 99999) : -1
  }
  if (a.alive === false) {
    return b.alive === true ? 1 : b.alive === false ? 0 : -1
  }
  return 1
}

export function sortNodesForRoster<T extends NodeRosterRow>(nodes: T[]): T[] {
  const sinkDomestic = hasAliveNonDomesticRu(nodes)
  return [...nodes].sort((a, b) => compareNodesForRoster(a, b, sinkDomestic))
}

/** Tags for AUTO / leastPing — foreign first; domestic only when nothing else exists. */
export function autoBalancerTags(allTags: string[]): string[] {
  const foreign = allTags.filter((t) => !isDomesticRuNode(t))
  return foreign.length > 0 ? foreign : allTags
}
