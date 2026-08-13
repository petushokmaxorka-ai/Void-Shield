// ═══════════════════════════════════════════════════════════
// VOID-SHIELD — parser unit tests (node:test, zero deps)
// ═══════════════════════════════════════════════════════════
// Run: npm run build && node scripts/test-parsers.mjs
// Tests the compiled out/main/subscription.js (so we exercise the
// exact code that ships in the AppImage).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSubscription,
  parseUserInfoHeader,
} from '../out/test-src/main/subscription.js'
import { buildSingboxConfig } from '../out/test-src/main/singbox-config-builder.js'
import { buildConfig } from '../out/test-src/main/config-builder.js'
import { execFileSync } from 'child_process'
import { existsSync, writeFileSync } from 'fs'

// ─── fixture builders ───────────────────────────────────────
// Realistic VLESS-REALITY link (secrets are obviously fake test values).
const VLESS_REALITY = 'vless://0d3f1b2a-4c5d-6e7f-8a9b-0c1d2e3f4a5b@example.com:443' +
  '?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome' +
  '&pbk=abcdef0123456789012345678901234567890123456&sid=0a1b2c3d' +
  '&type=tcp&flow=xtls-rprx-vision#TestNode-REALITY'

const VLESS_WS = 'vless://0d3f1b2a-4c5d-6e7f-8a9b-0c1d2e3f4a5b@example.com:8080' +
  '?encryption=none&type=ws&path=%2Fws&host=cdn.example.com#WS-Node'

const TROJAN_TLS = 'trojan://s3cretP@ss@trojan.example.com:443' +
  '?security=tls&sni=trojan.example.com&type=grpc&serviceName=gstream#Trojan-gRPC'

// base64 of {"v":"2","ps":"vmess-test","add":"vm.example.com","port":"443","id":"abcd-1234","aid":"0","net":"ws","type":"none","host":"h.example.com","path":"/vm","tls":"tls","sni":"vm.example.com"}
const VMESS_B64 = 'vmess://' + Buffer.from(
  JSON.stringify({ v: '2', ps: 'vmess-test', add: 'vm.example.com', port: '443', id: 'abcd-1234', aid: '0', net: 'ws', host: 'h.example.com', path: '/vm', tls: 'tls', sni: 'vm.example.com' })
).toString('base64')

// SIP002 ss link
const SS_SIP002 = 'ss://' + Buffer.from('aes-256-gcm:password123').toString('base64') + '@ss.example.com:8388#SS-SIP002'

// Valid curve25519 WireGuard keys (sing-box validates key length on check).
// Generated via: sing-box generate wg-keypair
const WG_PRIV = 'GGb387Ww17KSUWXNhIk6jEdG7UH1c3kDon7ys+pqsE0='
const WG_PUB = 'HU7gsJ8p5/Qo9hSWT2oGIGc4NXxZTBBIRB38UJLduEk='

// ─── tests ──────────────────────────────────────────────────

test('parses VLESS REALITY link with all fields', () => {
  const r = parseSubscription(VLESS_REALITY)
  assert.equal(r.format, 'share-links')
  assert.equal(r.nodes.length, 1)
  const n = r.nodes[0]
  assert.equal(n.protocol, 'vless')
  assert.equal(n.server, 'example.com')
  assert.equal(n.port, 443)
  assert.equal(n.flow, 'xtls-rprx-vision')
  assert.equal(n.transport.type, 'tcp')
  assert.equal(n.tls.reality?.publicKey, 'abcdef0123456789012345678901234567890123456')
  assert.equal(n.tls.reality?.shortId, '0a1b2c3d')
  assert.equal(n.tls.reality?.serverName, 'www.microsoft.com')
  assert.equal(n.tls.reality?.fingerprint, 'chrome')
})

test('parses VLESS over WebSocket', () => {
  const r = parseSubscription(VLESS_WS)
  assert.equal(r.nodes.length, 1)
  const n = r.nodes[0]
  assert.equal(n.transport.type, 'ws')
  assert.equal(n.transport.path, '/ws')
  assert.equal(n.transport.host, 'cdn.example.com')
  assert.equal(n.tls.enabled, false)
})

test('parses Trojan over gRPC with TLS', () => {
  const r = parseSubscription(TROJAN_TLS)
  assert.equal(r.nodes.length, 1)
  const n = r.nodes[0]
  assert.equal(n.protocol, 'trojan')
  assert.equal(n.auth, 's3cretP@ss')
  assert.equal(n.transport.type, 'grpc')
  assert.equal(n.transport.serviceName, 'gstream')
  assert.equal(n.tls.enabled, true)
  assert.equal(n.tls.serverName, 'trojan.example.com')
})

test('parses VMess base64-JSON link', () => {
  const r = parseSubscription(VMESS_B64)
  assert.equal(r.nodes.length, 1)
  const n = r.nodes[0]
  assert.equal(n.protocol, 'vmess')
  assert.equal(n.auth, 'abcd-1234')
  assert.equal(n.alterId, 0)
  assert.equal(n.transport.type, 'ws')
  assert.equal(n.transport.path, '/vm')
  assert.equal(n.tls.enabled, true)
})

test('parses Shadowsocks SIP002 link', () => {
  const r = parseSubscription(SS_SIP002)
  assert.equal(r.nodes.length, 1)
  const n = r.nodes[0]
  assert.equal(n.protocol, 'shadowsocks')
  assert.equal(n.server, 'ss.example.com')
  assert.equal(n.port, 8388)
  assert.equal(n.cipher, 'aes-256-gcm')
  assert.equal(n.auth, 'password123')
})

test('parses base64-wrapped list of share links', () => {
  const blob = Buffer.from([VLESS_REALITY, VMESS_B64, SS_SIP002].join('\n')).toString('base64')
  const r = parseSubscription(blob)
  assert.equal(r.format, 'share-links')
  assert.equal(r.nodes.length, 3)
  assert.equal(r.nodes[0].protocol, 'vless')
  assert.equal(r.nodes[1].protocol, 'vmess')
  assert.equal(r.nodes[2].protocol, 'shadowsocks')
})

test('parses Clash YAML with mixed proxy types', () => {
  const yaml = `
mixed-port: 7890
proxies:
  - name: "reality-node"
    type: vless
    server: r.example.com
    port: 443
    uuid: u1
    flow: xtls-rprx-vision
    network: tcp
    servername: r.example.com
    reality-opts:
      public-key: pk1
      short-id: sid1
    client-fingerprint: chrome
  - name: "trojan-node"
    type: trojan
    server: t.example.com
    port: 443
    password: pw
    network: ws
    ws-opts:
      path: /t
      headers:
        Host: t.example.com
  - name: "ss-node"
    type: ss
    server: s.example.com
    port: 8388
    cipher: aes-256-gcm
    password: sspw
proxy-groups: []
rules: []
`
  const r = parseSubscription(yaml)
  assert.equal(r.format, 'clash-yaml')
  assert.equal(r.nodes.length, 3)
  assert.equal(r.nodes[0].protocol, 'vless')
  assert.equal(r.nodes[0].tls.reality?.publicKey, 'pk1')
  assert.equal(r.nodes[1].protocol, 'trojan')
  assert.equal(r.nodes[1].transport.type, 'ws')
  assert.equal(r.nodes[1].transport.path, '/t')
  assert.equal(r.nodes[2].protocol, 'shadowsocks')
  assert.equal(r.nodes[2].cipher, 'aes-256-gcm')
})

test('DROPS fake/placeholder nodes (0.0.0.0:1 marketing stubs)', () => {
  // This is the EXACT shape the waynode provider returns when it wants
  // you to install its own app. Must NOT be parsed as a real node.
  const yaml = `
proxies:
  - name: "Приложение не поддерживается"
    type: vless
    server: 0.0.0.0
    port: 1
    uuid: x
    network: tcp
  - name: "Установите HAPP"
    type: vless
    server: 0.0.0.0
    port: 1
    uuid: y
    network: tcp
`
  const r = parseSubscription(yaml)
  assert.equal(r.nodes.length, 0)
  assert.equal(r.dropped, 2)
  assert.match(r.error ?? '', /whitelist|HAPP|fake|placeholder/i)
})

test('whitelist stub error mentions Import FlClashX', () => {
  const yaml = `
proxies:
  - name: "Установите HAPP"
    type: vless
    server: 0.0.0.0
    port: 1
    uuid: y
    network: tcp
`
  const r = parseSubscription(yaml)
  assert.equal(r.nodes.length, 0)
  assert.match(r.error ?? '', /Import FlClashX|Custom User-Agent/i)
})

test('keeps real nodes alongside (mixed real + fake)', () => {
  const yaml = `
proxies:
  - name: "fake"
    type: vless
    server: 0.0.0.0
    port: 1
    uuid: x
  - name: "real"
    type: vless
    server: real.example.com
    port: 443
    uuid: y
    network: tcp
`
  const r = parseSubscription(yaml)
  assert.equal(r.nodes.length, 1)
  assert.equal(r.nodes[0].tag, 'real')
  assert.equal(r.dropped, 1)
})

test('parseUserInfoHeader parses bytes + human sizes + expiry', () => {
  const u = parseUserInfoHeader('upload=5MB; download=76235908096; total=1486058684416; expire=1792245085')
  assert.ok(u)
  assert.equal(u.upload, 5 * 1024 * 1024)
  assert.equal(u.download, 76235908096)
  assert.equal(u.total, 1486058684416)
  assert.equal(u.expire, 1792245085)
})

test('parseUserInfoHeader handles unlimited (total=0)', () => {
  const u = parseUserInfoHeader('upload=0; download=561936838521; total=0; expire=1792245085')
  assert.ok(u)
  assert.equal(u.total, 0)
  assert.equal(u.download, 561936838521)
})

test('rejects empty subscription', () => {
  const r = parseSubscription('')
  assert.equal(r.nodes.length, 0)
  assert.equal(r.format, 'unknown')
})

test('handles unknown format gracefully', () => {
  const r = parseSubscription('just some random text\nwith no proxies')
  assert.equal(r.format, 'unknown')
  assert.equal(r.nodes.length, 0)
})

// ─── Phase 2 protocol parsers ───────────────────────────────

// Hysteria2 link (sing-box only; QUIC-based).
const HY2_LINK = 'hysteria2://s3cret@hy2.example.com:443?sni=hy2.example.com&obfs=salamander&obfs-password=obpw&up=50&down=200#Hy2Node'
const HY2_ALIAS = 'hy2://auth-pw@hy2b.example.com:8443?sni=hy2b.example.com#Hy2Alias'

test('parses Hysteria2 link with obfs + bandwidth', () => {
  const r = parseSubscription(HY2_LINK)
  assert.equal(r.nodes.length, 1)
  const n = r.nodes[0]
  assert.equal(n.protocol, 'hysteria2')
  assert.equal(n.server, 'hy2.example.com')
  assert.equal(n.port, 443)
  assert.equal(n.auth, 's3cret')
  assert.equal(n.obfs, 'obpw')
  assert.equal(n.upMbps, 50)
  assert.equal(n.downMbps, 200)
  assert.equal(n.tls.enabled, true)
  assert.equal(n.tls.alpn?.[0], 'h3')
})

test('parses hy2:// alias as Hysteria2', () => {
  const r = parseSubscription(HY2_ALIAS)
  assert.equal(r.nodes.length, 1)
  assert.equal(r.nodes[0].protocol, 'hysteria2')
})

// TUIC v5 link.
const TUIC_LINK = 'tuic://0d3f1b2a-4c5d-6e7f-8a9b-0c1d2e3f4a5b:tuicpw@tuic.example.com:443?sni=tuic.example.com&congestion_control=bbr&udp_relay_mode=native#TuicNode'

test('parses TUIC v5 link', () => {
  const r = parseSubscription(TUIC_LINK)
  assert.equal(r.nodes.length, 1)
  const n = r.nodes[0]
  assert.equal(n.protocol, 'tuic')
  assert.equal(n.server, 'tuic.example.com')
  assert.equal(n.port, 443)
  assert.equal(n.auth, '0d3f1b2a-4c5d-6e7f-8a9b-0c1d2e3f4a5b')  // uuid
  assert.equal(n.cipher, 'tuicpw')  // password
  assert.equal(n.congestionControl, 'bbr')
  assert.equal(n.udpRelayMode, 'native')
})

// WireGuard link. Keys must be valid curve25519 base64 (sing-box validates).
const WG_LINK = `wireguard://wg.example.com:51820?privatekey=${WG_PRIV}&publickey=${WG_PUB}&address=10.0.0.2/32&mtu=1280#WGnode`

test('parses WireGuard link', () => {
  const r = parseSubscription(WG_LINK)
  assert.equal(r.nodes.length, 1)
  const n = r.nodes[0]
  assert.equal(n.protocol, 'wireguard')
  assert.equal(n.server, 'wg.example.com')
  assert.equal(n.port, 51820)
  assert.equal(n.wireguard?.privateKey, WG_PRIV)
  assert.equal(n.wireguard?.peerPublicKey, WG_PUB)
  assert.deepEqual(n.wireguard?.localAddress, ['10.0.0.2/32'])
  assert.equal(n.wireguard?.mtu, 1280)
})

test('parses Clash YAML with hysteria2 + tuic + wireguard sections', () => {
  const yaml = `
proxies:
  - name: "hy2-yaml"
    type: hysteria2
    server: h.example.com
    port: 443
    password: hpw
    sni: h.example.com
    up: 30
    down: 100
    obfs: salamander
    obfs-password: op
  - name: "tuic-yaml"
    type: tuic
    server: t.example.com
    port: 443
    uuid: t-uuid
    password: tpw
    sni: t.example.com
    congestion-controller: bbr
    udp-relay-mode: native
  - name: "wg-yaml"
    type: wireguard
    ip: ["10.0.0.3/32"]
    private-key: ${WG_PRIV}
    mtu: 1400
    peers:
      - server: wg.example.com
        port: 51820
        public-key: ${WG_PUB}
`
  const r = parseSubscription(yaml)
  assert.equal(r.format, 'clash-yaml')
  assert.equal(r.nodes.length, 3)
  assert.equal(r.nodes[0].protocol, 'hysteria2')
  assert.equal(r.nodes[0].obfs, 'op')
  assert.equal(r.nodes[1].protocol, 'tuic')
  assert.equal(r.nodes[1].cipher, 'tpw')
  assert.equal(r.nodes[2].protocol, 'wireguard')
  assert.equal(r.nodes[2].wireguard?.peerPublicKey, WG_PUB)
})

// ─── sing-box config validation (real binary) ───────────────
// If sing-box binary is present, validate that the generated config passes
// `sing-box check`. Skips gracefully if binary missing (CI without fetch).

const SINGBOX_BIN = new URL('../resources/bin/linux-x64/sing-box', import.meta.url).pathname
const SINGBOX_AVAILABLE = existsSync(SINGBOX_BIN)

test('sing-box config validates with real binary (all protocols)', { skip: !SINGBOX_AVAILABLE && 'sing-box binary not fetched' }, () => {
  // Generate a valid x25519 public key for REALITY (sing-box validates length).
  const validPbk = Buffer.from('a'.repeat(32)).toString('base64url')
  const links = [
    `vless://0d3f1b2a-4c5d-6e7f-8a9b-0c1d2e3f4a5b@reality.example.com:443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=${validPbk}&sid=0a&type=tcp&flow=xtls-rprx-vision#RealityNode`,
    'vmess://' + Buffer.from(JSON.stringify({v:'2',ps:'VMessWS',add:'vm.example.com',port:'443',id:'ab-12',aid:'0',net:'ws',host:'cdn.x.com',path:'/vm',tls:'tls',sni:'vm.example.com'})).toString('base64'),
    'trojan://pass@trojan.example.com:443?security=tls&sni=t.example.com&type=grpc&serviceName=g#TrojanGRPC',
    'ss://' + Buffer.from('chacha20-ietf-poly1305:sspass').toString('base64') + '@ss.example.com:8388#SSnode',
    HY2_LINK,
    TUIC_LINK,
    WG_LINK,
  ].join('\n')
  const parsed = parseSubscription(links)
  assert.equal(parsed.nodes.length, 7, 'all 7 protocols should parse')
  const cfg = buildSingboxConfig(parsed.nodes)
  // Write to temp file and run sing-box check.
  const tmpConfig = '/tmp/vs-test-singbox-config.json'
  writeFileSync(tmpConfig, JSON.stringify(cfg, null, 2))
  let threw = null
  try {
    execFileSync(SINGBOX_BIN, ['check', '-c', tmpConfig], { stdio: 'pipe', timeout: 10000 })
  } catch (e) {
    threw = e
  }
  assert.equal(threw, null, `sing-box check failed:\n${threw?.stderr?.toString() ?? threw?.message}`)
})

// ─── xray config: SOCKS-only by default (Windows ignition) ──
test('xray buildConfig defaults to SOCKS-only (no TUN)', () => {
  const parsed = parseSubscription(VLESS_REALITY)
  assert.equal(parsed.nodes.length, 1)
  const cfg = buildConfig(parsed.nodes)
  const tags = (cfg.inbounds || []).map((i) => i.tag)
  assert.ok(tags.includes('mixed-in'), 'SOCKS inbound required')
  assert.ok(!tags.includes('tun-in'), 'TUN must be opt-in (enableTun)')
  const withTun = buildConfig(parsed.nodes, { enableTun: true })
  assert.ok(withTun.inbounds.some((i) => i.tag === 'tun-in'), 'enableTun adds tun-in')
})

const XRAY_BIN = new URL('../resources/bin/linux-x64/xray', import.meta.url).pathname
const XRAY_HOME = process.env.HOME
  ? `${process.env.HOME}/.config/void-shield/bin/xray`
  : ''
const XRAY_AVAILABLE = existsSync(XRAY_BIN) || existsSync(XRAY_HOME)

test('xray SOCKS-only config validates with real binary', { skip: !XRAY_AVAILABLE && 'xray binary not found' }, () => {
  const bin = existsSync(XRAY_BIN) ? XRAY_BIN : XRAY_HOME
  const parsed = parseSubscription(VLESS_REALITY)
  const cfg = buildConfig(parsed.nodes) // enableTun false
  const tmpConfig = '/tmp/vs-test-xray-socks.json'
  writeFileSync(tmpConfig, JSON.stringify(cfg, null, 2))
  let threw = null
  try {
    execFileSync(bin, ['run', '-test', '-c', tmpConfig], { stdio: 'pipe', timeout: 15000 })
  } catch (e) {
    threw = e
  }
  assert.equal(threw, null, `xray -test failed:\n${threw?.stderr?.toString() ?? threw?.message}`)
})
