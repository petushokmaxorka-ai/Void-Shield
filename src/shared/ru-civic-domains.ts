// RU civic / e-gov hosts. Foreign VPN (and many RU VPN exits) break these.
// Per-connection split: these go ru-home or direct; everything else stays foreign AUTO.

/** Registrable suffixes — xray `domain:` / sing-box `domain_suffix`. */
export const RU_CIVIC_DOMAIN_SUFFIXES: string[] = [
  'gosuslugi.ru',
  'gosuslugi.culture.ru',
  'esia.gosuslugi.ru',
  'pos.gosuslugi.ru',
  'gov.ru',
  'nalog.ru',
  'nalog.gov.ru',
  'mos.ru',
  'mosreg.ru',
  'mvd.ru',
  'pfr.gov.ru',
  'sfr.gov.ru',
  'fssp.gov.ru',
  'zakupki.gov.ru',
  'sudrf.ru',
  'roskazna.gov.ru',
  'cbr.ru',
  'gu.spb.ru',
  'kremlin.ru',
  'government.ru',
]

/** xray routing domain matchers (suffix of host). */
export function ruCivicXrayDomains(): string[] {
  return RU_CIVIC_DOMAIN_SUFFIXES.map((d) => `domain:${d}`)
}
