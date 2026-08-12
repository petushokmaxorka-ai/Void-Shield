// ═══════════════════════════════════════════════════════════
// VOID-SHIELD — sing-box Config Builder
// ═══════════════════════════════════════════════════════════
// Генерирует sing-box JSON config из массива нод (тех же ParsedNode[],
// что потребляет xray-билдер). sing-box даёт нативные urltest (авто-выбор
// быстрейшего узла) и selector outbounds + clash-api (для UI).
//
// Структура: TUN inbound (system-wide перехват) + mixed SOCKS 7890
//   (для egress-IP пробы) + clash-api :9090 (для UI — трафик/коннекты/
//   логи в реал-тайм) + outbounds (по одному на ноду) + urltest (auto)
//   + selector (manual) + route rules (LAN bypass).

import type { ParsedNode, TransportOpts, TlsOpts } from './subscription'
import { scenarioRules, scenarioRuleSetDefs, scenarioFinal, type Scenario } from './routing-scenarios.js'
import { autoBalancerTags } from '../shared/node-region'

// clash-api port — NOT 9090 (often occupied by mihomo/clash on dev machines).
// 9097 is our dedicated port; the runner + vpn-manager reference this constant.
const CLASH_API = '127.0.0.1:9097'
const MIXED_PORT = 7899

// ─── v2ray-transport (sing-box unified transport shape) ─────
// sing-box mergила ws/grpc/http/httpupgrade в один блок `v2ray-transport`
// с полем type. Это разнooбразнее чем xray (где каждый транспорт имеет
// свой *Settings).
function buildV2rayTransport(t: TransportOpts): Record<string, unknown> | undefined {
  switch (t.type) {
    case 'tcp':
    case 'raw':
    case 'none':
      return undefined  // tcp — no transport block needed in sing-box
    case 'ws':
      return {
        type: 'ws',
        path: t.path ?? '/',
        ...(t.host ? { headers: { Host: t.host, ...(t.headers ?? {}) } } : {}),
        ...(t.maxEarlyData != null ? {
          max_early_data: t.maxEarlyData,
          early_data_header_name: t.earlyDataHeaderName ?? 'Sec-WebSocket-Protocol',
        } : {}),
      }
    case 'grpc':
      return {
        type: 'grpc',
        service_name: t.serviceName ?? '',
        ...(t.mode === 'multi' ? { idle_timeout: '15s' } : {}),
      }
    case 'xhttp':
    case 'splithttp':
      return {
        type: 'xhttp',
        path: t.path ?? '/',
        ...(t.host ? { host: t.host } : {}),
        ...(t.mode ? { mode: t.mode } : {}),
      }
    case 'httpupgrade':
      return { type: 'httpupgrade', path: t.path ?? '/', ...(t.host ? { host: t.host } : {}) }
    case 'h2':
    case 'http':
      return {
        type: 'http',
        path: t.path ?? '/',
        ...(t.h2Hosts?.length ? { host: t.h2Hosts } : t.host ? { host: [t.host] } : {}),
      }
    case 'quic':
      // sing-box has no separate quic transport in v2ray-transport; quic is
      // a transport only for Hysteria/TUIC outbounds, not vmess/vless. Skip.
      return undefined
  }
  return undefined
}

// ─── TLS block (unified for all outbounds) ──────────────────
function buildTls(tls: TlsOpts): Record<string, unknown> | undefined {
  if (tls.reality) {
    return {
      enabled: true,
      server_name: tls.reality.serverName,
      utls: { enabled: true, fingerprint: tls.reality.fingerprint || 'chrome' },
      reality: {
        enabled: true,
        public_key: tls.reality.publicKey,
        short_id: tls.reality.shortId,
      },
    }
  }
  if (tls.enabled) {
    return {
      enabled: true,
      ...(tls.serverName ? { server_name: tls.serverName } : {}),
      ...(tls.insecure ? { insecure: true } : {}),
      ...(tls.alpn?.length ? { alpn: tls.alpn } : {}),
      ...(tls.fingerprint ? { utls: { enabled: true, fingerprint: tls.fingerprint } } : {}),
    }
  }
  return undefined
}

// ─── Build a single outbound from a parsed node ─────────────
// sing-box outbound shape differs per protocol but shares tls/transport.
function outboundFromNode(n: ParsedNode): Record<string, unknown> {
  const tls = buildTls(n.tls)
  const transport = buildV2rayTransport(n.transport)
  const common: Record<string, unknown> = {
    tag: n.tag,
    ...(tls ? { tls } : {}),
    ...(transport ? { transport } : {}),
  }
  switch (n.protocol) {
    case 'vless':
      return {
        type: 'vless',
        server: n.server,
        server_port: n.port,
        uuid: n.auth,
        ...(n.flow ? { flow: n.flow } : {}),
        ...common,
      }
    case 'vmess':
      return {
        type: 'vmess',
        server: n.server,
        server_port: n.port,
        uuid: n.auth,
        alter_id: n.alterId ?? 0,
        security: n.cipher ?? 'auto',
        ...common,
      }
    case 'trojan':
      return {
        type: 'trojan',
        server: n.server,
        server_port: n.port,
        password: n.auth,
        ...common,
      }
    case 'shadowsocks':
      return {
        type: 'shadowsocks',
        server: n.server,
        server_port: n.port,
        method: n.cipher ?? 'aes-256-gcm',
        password: n.auth,
        ...common,
      }
    case 'hysteria2':
      return {
        type: 'hysteria2',
        tag: n.tag,
        server: n.server,
        server_port: n.port,
        up_mbps: n.upMbps ?? 100,
        down_mbps: n.downMbps ?? 100,
        ...(n.obfs ? { obfs: { type: 'salamander', password: n.obfs } } : {}),
        password: n.auth,
        tls: { enabled: true, server_name: n.tls.serverName, insecure: n.tls.insecure, alpn: n.tls.alpn ?? ['h3'] },
      }
    case 'tuic':
      return {
        type: 'tuic',
        tag: n.tag,
        server: n.server,
        server_port: n.port,
        uuid: n.auth,
        password: n.cipher ?? '',
        congestion_control: n.congestionControl ?? 'bbr',
        udp_relay_mode: n.udpRelayMode ?? 'native',
        tls: { enabled: true, server_name: n.tls.serverName, insecure: n.tls.insecure, alpn: n.tls.alpn ?? ['h3'] },
      }
    case 'wireguard':
      // Handled separately as an endpoint (sing-box 1.11+ deprecated the
      // wireguard outbound). See wireguardEndpointFromNode / endpoints[].
      // Should never reach here — wireguard nodes are filtered out above.
      throw new Error('wireguard must be built as endpoint, not outbound')
    case 'shadowtls':
      // ShadowTLS wraps another protocol (usually vless/trojan) over a
      // TLS camouflage stream. We emit it as a trojan-via-shadowtls outbound.
      // Full ShadowTLS-v3 chain (shadowtls outbound + nested outbound) is a
      // future refinement; for now expose the shadowtls layer.
      return {
        type: 'shadowtls',
        tag: n.tag,
        server: n.server,
        server_port: n.port,
        version: n.shadowtlsVersion ?? 3,
        password: n.auth,
        tls: { enabled: true, server_name: n.tls.serverName, ...(n.tls.insecure ? { insecure: true } : {}) },
      }
  }
}

// ─── Main config builder ────────────────────────────────────
export interface SingboxBuildOptions {
  /** Optional filter predicate for outbounds. */
  filter?: (n: ParsedNode) => boolean
  /** URL test target (default: cloudflare 204). */
  testUrl?: string
  /** URL test interval (default: 3m). */
  testInterval?: string
  /** Optional DNS servers (default: cloudflare DOH + local). */
  dnsServers?: Record<string, unknown>[]
  /** Routing scenario (default: proxy). Determines which rule-sets to
   *  download + whether RU/CN/all traffic bypasses the proxy. */
  scenario?: Scenario
  /** Enable TUN inbound (system-wide traffic capture). Default false — mixed
   *  (SOCKS+HTTP) is primary to avoid DNS bootstrap loops with TUN. */
  enableTun?: boolean
  /** Set OS system proxy to point at our mixed inbound. Default false. */
  setSystemProxy?: boolean
}

// ─── WireGuard endpoint (sing-box 1.11+ replaces the old outbound) ──
function wireguardEndpointFromNode(n: ParsedNode): Record<string, unknown> {
  const wg = n.wireguard
  return {
    type: 'wireguard',
    tag: n.tag,
    system: false,
    mtu: wg?.mtu ?? 1280,
    address: wg?.localAddress ?? [],
    private_key: wg?.privateKey ?? '',
    peers: [{
      address: n.server,
      port: n.port,
      public_key: wg?.peerPublicKey ?? '',
      ...(wg?.preSharedKey ? { pre_shared_key: wg.preSharedKey } : {}),
      allowed_ips: ['0.0.0.0/0'],
      ...(wg?.reserved ? { reserved: wg.reserved } : {}),
      persistent_keepalive_interval: 25,
    }],
  }
}

const URLTEST_TAG = 'auto'
const SELECTOR_TAG = 'proxy'

export function buildSingboxConfig(nodes: ParsedNode[], opts: SingboxBuildOptions = {}): Record<string, unknown> {
  const keep = opts.filter ? nodes.filter(opts.filter) : nodes
  // WireGuard is an endpoint (not an outbound) in sing-box 1.11+. Separate
  // them: wireguard nodes go into endpoints[], everything else into outbounds[].
  // Their tags are unified so selector/urltest can reference both kinds.
  const wgNodes = keep.filter((n) => n.protocol === 'wireguard')
  const otherNodes = keep.filter((n) => n.protocol !== 'wireguard')
  const outbounds = otherNodes.map(outboundFromNode)
  const endpoints = wgNodes.map(wireguardEndpointFromNode)
  const tags = [...outbounds, ...endpoints].map((o) => o.tag as string)
  const autoTags = autoBalancerTags(tags)

  return {
    log: {
      level: 'info',  // 'info' to see inbound startup (debug bootstrapping)
      timestamp: true,
    },
    // clash-api — управление/UI: трафик, коннекты, логи, селекторы.
    // Это замена xray gRPC API. UI ходит сюда через WebSocket/HTTP.
    experimental: {
      clash_api: {
        external_controller: CLASH_API,
        default_mode: 'rule',
      },
      cache_file: {
        enabled: true,
        // urltest results кешируются между перезапусками → мгновенный старт.
      },
    },
    // DNS: explicit IPv4 UDP resolver. sing-box `type: 'local'` picked up the
    // IPv6 Tailscale resolver (fd7a:...) from /etc/resolv.conf and timed out —
    // TUN was intercepting its queries. Using an explicit IPv4 UDP server
    // (100.100.100.100 = Tailscale MagicDNS on this host, which resolves the
    // provider's private *.waynodes.ru domains) avoids both the IPv6 path and
    // the loopback. Fallback 1.1.1.1 for public domains.
    dns: {
      servers: opts.dnsServers ?? [
        { type: 'udp', tag: 'magicdns', server: '100.100.100.100' },
        { type: 'udp', tag: 'cloudflare', server: '1.1.1.1' },
      ],
      final: 'magicdns',
      strategy: 'ipv4_only',
      reverse_mapping: true,
      independent_cache: true,
      // Do NOT use the system resolver for dial — go through our explicit servers.
      disable_cache: false,
    },
    inbounds: [
      // 1. TUN — перехватывает ВЕСЬ системный трафик. DISABLED by default —
      //    TUN causes a DNS-resolution loop for the proxy server's own domains
      //    (TUN intercepts the DNS query → routes it back through the proxy →
      //    proxy needs that same DNS to connect → deadlock). TUN should be a
      //    user-enabled opt-in after the proxy is verified working.
      //    Enable via opts.enableTun = true (Phase: tray toggle "System-wide").
      ...(opts.enableTun ? [{
        type: 'tun',
        tag: 'tun-in',
        interface_name: 'tun0',
        address: ['172.19.0.1/30'],
        auto_route: true,
        strict_route: true,
        stack: 'system',
        platform: { http_proxy: { enabled: false } },
      }] : []),
      // 2. Mixed (SOCKS+HTTP) — primary inbound. Apps configure proxy to
      //    127.0.0.1:7899 and all their traffic goes through the VPN. This is
      //    how v2rayN/Hiddify work by default (TUN is opt-in). No DNS loop.
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: MIXED_PORT,
        set_system_proxy: opts.setSystemProxy ?? false,
      },
    ],
    outbounds: [
      // urltest — авто-выбор самого быстрого узла (раз в interval).
      {
        type: 'urltest',
        tag: URLTEST_TAG,
        outbounds: autoTags,
        url: opts.testUrl ?? 'https://www.gstatic.com/generate_204',
        interval: opts.testInterval ?? '3m',
        tolerance: 50,        // ms — не прыгать между близкими узлами
        idle_timeout: '30m',
      },
      // selector — ручной выбор (UI переключает через clash-api).
      {
        type: 'selector',
        tag: SELECTOR_TAG,
        outbounds: [URLTEST_TAG, ...tags],
        default: URLTEST_TAG,
      },
      ...outbounds,
      // system outbounds
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
    ],
    // endpoints[] — WireGuard (sing-box 1.11+ replaced the old wg outbound).
    // Tags here are addressable from selector/urltest just like outbounds.
    ...(endpoints.length > 0 ? { endpoints } : {}),
    route: {
      rules: [
        // sniff action (replaces per-inbound sniff in 1.11+) — resolve domains
        // from TLS SNI / HTTP Host so domain rules work for TUN traffic.
        { action: 'sniff' },
        // DNS hijack — route DNS queries from TUN through sing-box DNS resolver.
        // (1.11+: `dns` outbound removed; use `action: 'hijack-dns'` rule.)
        { action: 'hijack-dns' },
        // Scenario-specific bypass rules (e.g. RU/CN domains → direct).
        // Generated BEFORE LAN-bypass so geo rules win for matching traffic.
        ...scenarioRules(opts.scenario ?? 'bypass-lan'),
        // LAN/private networks — always direct (no geoip rule-set needed).
        { ip_is_private: true, outbound: 'direct' },
      ],
      // Remote rule-sets (only those the scenario needs — sing-box downloads
      // + caches them; lazy, so an offline first-run still works without geo).
      // NO download_detour (sing-box 1.13: "empty direct outbound makes no
      // sense"); default path works for github downloads.
      rule_set: scenarioRuleSetDefs(opts.scenario ?? 'bypass-lan').map((d) => ({
        tag: d.tag,
        type: 'remote',
        format: 'binary',  // .srs = sing-box headless binary rule-set
        url: d.url,
        update_interval: '7d',
      })),
      final: scenarioFinal(opts.scenario ?? 'bypass-lan', SELECTOR_TAG),
      auto_detect_interface: true,
      // 1.12+: outbound dial needs an explicit domain resolver.
      // Explicit IPv4 resolver for outbound dial (proxy server hostnames are
      // private domains resolved only by Tailscale MagicDNS 100.100.100.100).
      default_domain_resolver: { server: 'magicdns' },
    },
  }
}

// ─── Helpers exposed for the runner / vpn-manager ───────────
export const SINGBOX_URLTEST_TAG = URLTEST_TAG
export const SINGBOX_SELECTOR_TAG = SELECTOR_TAG
export const SINGBOX_CLASH_API = CLASH_API
export const SINGBOX_MIXED_PORT = MIXED_PORT
