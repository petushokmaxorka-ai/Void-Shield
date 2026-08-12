// ═══════════════════════════════════════════════════════════
// VOID-SHIELD — xray Config Builder (multi-protocol)
// ═══════════════════════════════════════════════════════════
// Генерирует валидный xray JSON config из массива нод.
// Поддержка: vless (+reality), vmess, trojan, shadowsocks.
// Транспорты: tcp, ws, grpc, xhttp, httpupgrade, h2, quic.
//
// Структура: TUN (system-wide перехват) + SOCKS 7890 (для egress-IP пробы)
//   + gRPC API 8086 (для UI) + outbounds + leastPing balancer.

import type { ParsedNode, Transport, TransportOpts, TlsOpts } from './subscription'
import { XRAY_GRPC_ADDR, XRAY_SOCKS_HOST, XRAY_SOCKS_PORT } from './xray-constants'

const BALANCER_TAG = 'best'

// ─── streamSettings builder ─────────────────────────────────
// Translates the normalized TransportOpts + TlsOpts into xray's
// streamSettings sub-objects. This was the big Phase-1 gap: the
// old builder copied `network` verbatim and emitted NO sub-settings,
// producing invalid configs for any non-tcp transport.
function buildStreamSettings(network: Transport, t: TransportOpts, tls: TlsOpts): Record<string, unknown> {
  const ss: Record<string, unknown> = { network }

  // ── transport sub-settings ──
  switch (t.type) {
    case 'ws':
      ss.wsSettings = {
        path: t.path ?? '/',
        ...(t.host ? { headers: { Host: t.host, ...(t.headers ?? {}) } } : {}),
        ...(t.maxEarlyData != null ? { maxEarlyData: t.maxEarlyData, earlyDataHeaderName: t.earlyDataHeaderName ?? 'Sec-WebSocket-Protocol' } : {}),
      }
      break
    case 'grpc':
      ss.grpcSettings = {
        serviceName: t.serviceName ?? '',
        ...(t.mode === 'multi' ? { multiMode: true } : {}),
      }
      break
    case 'xhttp':
    case 'splithttp':
      ss.network = 'splithttp'
      ss.splithttpSettings = {
        path: t.path ?? '/',
        ...(t.host ? { host: t.host } : {}),
        ...(t.mode ? { mode: t.mode } : {}),
      }
      break
    case 'httpupgrade':
      ss.httpupgradeSettings = {
        path: t.path ?? '/',
        ...(t.host ? { host: t.host } : {}),
      }
      break
    case 'h2':
    case 'http':
      ss.network = 'http'
      ss.httpSettings = {
        path: t.path ?? '/',
        ...(t.h2Hosts?.length ? { host: t.h2Hosts } : t.host ? { host: [t.host] } : {}),
      }
      break
    case 'quic':
      ss.quicSettings = {
        security: t.quicSecurity ?? 'none',
        ...(t.quicKey ? { key: t.quicKey } : {}),
      }
      break
    case 'tcp':
    default:
      // tcp has no sub-settings unless header obfs is used (rare; skip).
      break
  }

  // ── security / tls / reality ──
  if (tls.reality) {
    ss.security = 'reality'
    ss.realitySettings = {
      serverName: tls.reality.serverName,
      fingerprint: tls.reality.fingerprint || 'chrome',
      publicKey: tls.reality.publicKey,
      shortId: tls.reality.shortId,
      ...(tls.reality.spiderX ? { spiderX: tls.reality.spiderX } : {}),
    }
  } else if (tls.enabled) {
    ss.security = 'tls'
    ss.tlsSettings = {
      ...(tls.serverName ? { serverName: tls.serverName } : {}),
      ...(tls.insecure ? { allowInsecure: true } : {}),
      ...(tls.alpn?.length ? { alpn: tls.alpn } : {}),
      ...(tls.fingerprint ? { fingerprint: tls.fingerprint } : {}),
    }
  } else {
    ss.security = 'none'
  }

  return ss
}

// ─── Build a single outbound from a parsed node ─────────────
function outboundFromNode(n: ParsedNode): Record<string, unknown> {
  const streamSettings = buildStreamSettings(n.network, n.transport, n.tls)
  switch (n.protocol) {
    case 'vless':
      return {
        tag: n.tag,
        protocol: 'vless',
        settings: {
          vnext: [{
            address: n.server,
            port: n.port,
            users: [{
              id: n.auth,
              encryption: 'none',
              ...(n.flow ? { flow: n.flow } : {}),
            }],
          }],
        },
        streamSettings,
      }
    case 'vmess':
      return {
        tag: n.tag,
        protocol: 'vmess',
        settings: {
          vnext: [{
            address: n.server,
            port: n.port,
            users: [{
              id: n.auth,
              alterId: n.alterId ?? 0,
              security: n.cipher ?? 'auto',
            }],
          }],
        },
        streamSettings,
      }
    case 'trojan':
      return {
        tag: n.tag,
        protocol: 'trojan',
        settings: {
          servers: [{
            address: n.server,
            port: n.port,
            password: n.auth,
          }],
        },
        streamSettings,
      }
    case 'shadowsocks':
      return {
        tag: n.tag,
        protocol: 'shadowsocks',
        settings: {
          servers: [{
            address: n.server,
            port: n.port,
            method: n.cipher ?? 'aes-256-gcm',
            password: n.auth,
          }],
        },
        streamSettings,
      }
  }
}

// ─── TUN inbound (system-wide traffic interception) ─────────
function tunInbound(): Record<string, unknown> {
  // xray TUN on Linux needs explicit inet4 + interface name (autoRoute alone is not enough).
  return {
    tag: 'tun-in',
    protocol: 'tun',
    settings: {
      name: 'xray0',
      mtu: 1500,
      inet4_address: '172.19.0.1/30',
      autoRoute: true,
      strictRoute: true,
      stack: 'system',
    },
  }
}

// ─── Main config builder ────────────────────────────────────
export interface BuildOptions {
  /** Optional filter predicate for outbounds (e.g. drop RU nodes). */
  filter?: (n: ParsedNode) => boolean
  /** Custom DNS servers (default: cloudflare + google + localhost). */
  dnsServers?: Record<string, unknown>[]
}

export function buildConfig(nodes: ParsedNode[], opts: BuildOptions = {}): Record<string, unknown> {
  const keep = opts.filter ? nodes.filter(opts.filter) : nodes
  const outbounds = keep.map(outboundFromNode)
  const tags = outbounds.map((o) => o.tag as string)

  return {
    log: { loglevel: 'warning' },
    // gRPC API — для UI (ObservatoryService, RoutingService, StatsService).
    api: {
      tag: 'api',
      listen: XRAY_GRPC_ADDR,
      services: ['HandlerService', 'LoggerService', 'RoutingService', 'ObservatoryService', 'StatsService'],
    },
    stats: {},
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: {
        statsInboundUplink: true,
        statsInboundDownlink: true,
        statsOutboundUplink: true,
        statsOutboundDownlink: true,
      },
    },
    // Observatory: проверяет alive/пинг для balance leastPing.
    observatory: {
      subjectSelector: tags,
      probeUrl: 'https://www.gstatic.com/generate_204',
      probeInterval: '30s',  // было 1m — чаще для актуальности выбора
      enableConcurrency: true,
    },
    dns: {
      servers: opts.dnsServers ?? [
        { address: '1.1.1.1', port: 53 },
        { address: '8.8.8.8', port: 53 },
        { address: 'localhost' },
      ],
      queryStrategy: 'UseIP4',
      disableCache: false,
    },
    inbounds: [
      tunInbound(),
      {
        tag: 'mixed-in',
        listen: XRAY_SOCKS_HOST,
        port: XRAY_SOCKS_PORT,
        protocol: 'socks',
        settings: { auth: 'noauth', udp: true },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
      },
    ],
    outbounds: [
      ...outbounds,
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
    ],
    routing: {
      domainStrategy: 'Use_IP4',
      balancers: [{
        tag: BALANCER_TAG,
        selector: tags,
        strategy: { type: 'leastPing' },
        fallbackTag: tags[0] ?? 'direct',
      }],
      rules: [
        // Private/LAN networks — direct, not via VPN (explicit CIDRs, no geoip.dat).
        { type: 'field', outboundTag: 'direct', ip: [
          '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10',
          '127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', 'fc00::/7', 'fe80::/10',
        ] },
        // gRPC API inbound → api outbound (so xray can hear itself).
        { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
        // Everything else — through the balancer (TUN captures it).
        { type: 'field', balancerTag: BALANCER_TAG, network: 'tcp,udp' },
      ],
    },
  }
}
