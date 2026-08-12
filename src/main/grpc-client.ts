// ═══════════════════════════════════════════════════════════
// VOID-SHIELD DESKTOP — xray gRPC Client
// ═══════════════════════════════════════════════════════════
// Dynamic proto loading via @grpc/proto-loader (no codegen step).
// 4 stubs: RoutingService, ObservatoryService, StatsService.
// All calls loopback to void-shield xray API (127.0.0.1:8088).
//
// Direct port of voidshield.py gRPC surface (verified field names
// against proto/app/*/command/command.proto + config.proto).

import { join } from 'path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { XRAY_GRPC_ADDR } from './xray-constants'
import { isDomesticRuNode } from '../shared/node-region.js'

// ─── Constants ─────────────────────────────────────────────
const XRAY_API = XRAY_GRPC_ADDR
const BALANCER_TAG = 'best'

// ─── Proto root resolution ──────────────────────────────────
// In dev: <project>/proto (two levels up from out/main).
// In packaged app: process.resourcesPath/proto (electron-builder extraResources).
import { existsSync } from 'fs'

function protoRoot(): string {
  // Packaged Electron app exposes the resources directory here.
  if (process.resourcesPath) {
    const pkgRoot = join(process.resourcesPath, 'proto')
    if (existsSync(pkgRoot)) return pkgRoot
  }
  // Dev fallback: out/main → ../../proto
  return join(__dirname, '../../proto')
}

// proto-loader options: load all files together so imports resolve.
const packageDef = protoLoader.loadSync(
  [
    'app/router/command/command.proto',
    'app/observatory/command/command.proto',
    'app/stats/command/command.proto'
  ],
  {
    includeDirs: [protoRoot()],
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  }
)

const grpcProto: any = grpc.loadPackageDefinition(packageDef)

// ─── Stubs (lazy channel, reused across calls) ─────────────
let _channel: grpc.Channel | null = null

function channel(): grpc.Channel {
  if (!_channel) {
    _channel = new grpc.Channel(XRAY_API, grpc.credentials.createInsecure(), {})
  }
  return _channel
}

// Wrap a gRPC unary call in a Promise (proto-loader gives callback stubs).
function unary<T>(
  stub: any,
  method: string,
  request: object,
  timeoutMs = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    stub[method](
      request,
      { deadline },
      (err: grpc.ServiceError | null, resp: T) => {
        if (err) reject(err)
        else resolve(resp)
      }
    )
  })
}

// ─── RoutingService (balancer control) ─────────────────────
// Methods: GetBalancerInfo, OverrideBalancerTarget
export interface BalancerInfo {
  activeNode: string
  override: string
  ok: boolean
}

function pickField(obj: unknown, ...keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined
  const rec = obj as Record<string, unknown>
  for (const k of keys) {
    if (rec[k] != null && rec[k] !== '') return rec[k]
  }
  return undefined
}

function outboundTag(row: OutboundStatus | Record<string, unknown>): string {
  const r = row as Record<string, unknown>
  return String(r.outbound_tag ?? r.outboundTag ?? '')
}

export async function getBalancerInfo(): Promise<BalancerInfo> {
  const RoutingService = new grpcProto.xray.app.router.command.RoutingService(
    XRAY_API,
    grpc.credentials.createInsecure()
  )
  try {
    const resp: any = await unary(
      RoutingService,
      'GetBalancerInfo',
      { tag: BALANCER_TAG },
      5000
    )
    const bal = (resp?.balancer ?? {}) as Record<string, unknown>
    const override = String(pickField(pickField(bal, 'override'), 'target') ?? '')
    const pt = pickField(bal, 'principle_target', 'principleTarget') as Record<string, unknown> | undefined
    const tags = pickField(pt ?? {}, 'tag')
    const activeNode =
      Array.isArray(tags) && tags.length ? String(tags[0]) : ''
    return { activeNode, override, ok: true }
  } catch {
    return { activeNode: '', override: '', ok: false }
  }
}

/** When balancer API returns empty principle_target, infer from observatory least delay. */
export async function inferActiveNodeFromObservatory(): Promise<string> {
  try {
    const obs = await getOutboundStatus()
    const alive = (obs.status ?? []).filter((s) => Boolean(s.alive))
    if (!alive.length) return ''
    const foreignAlive = alive.filter((s) => !isDomesticRuNode(outboundTag(s)))
    const pool = foreignAlive.length > 0 ? foreignAlive : alive
    pool.sort((a, b) => Number(a.delay ?? 99999) - Number(b.delay ?? 99999))
    return outboundTag(pool[0])
  } catch {
    return ''
  }
}

export async function overrideBalancerTarget(target: string): Promise<void> {
  const RoutingService = new grpcProto.xray.app.router.command.RoutingService(
    XRAY_API,
    grpc.credentials.createInsecure()
  )
  await unary(
    RoutingService,
    'OverrideBalancerTarget',
    { balancerTag: BALANCER_TAG, target },
    5000
  )
}

// ─── ObservatoryService (node health) ──────────────────────
// Method: GetOutboundStatus → ObservationResult { status: [OutboundStatus] }
export interface OutboundStatus {
  alive: boolean
  delay: string | number
  last_error_reason: string
  outbound_tag: string
  last_seen_time: string | number
  last_try_time: string | number
}

export interface ObservationResult {
  status: OutboundStatus[]
}

export async function getOutboundStatus(): Promise<ObservationResult> {
  const ObservatoryService =
    new grpcProto.xray.core.app.observatory.command.ObservatoryService(
      XRAY_API,
      grpc.credentials.createInsecure()
    )
  const resp: any = await unary(
    ObservatoryService,
    'GetOutboundStatus',
    {},
    6000
  )
  const outer = resp?.status ?? {}
  const raw = pickField(outer, 'status') ?? outer
  const list = Array.isArray(raw) ? raw : []
  const status: OutboundStatus[] = list.map((row: Record<string, unknown>) => ({
    alive: Boolean(row.alive),
    delay: (row.delay ?? row.Delay ?? 0) as string | number,
    last_error_reason: String(row.last_error_reason ?? row.lastErrorReason ?? ''),
    outbound_tag: outboundTag(row),
    last_seen_time: (row.last_seen_time ?? row.lastSeenTime ?? 0) as string | number,
    last_try_time: (row.last_try_time ?? row.lastTryTime ?? 0) as string | number,
  }))
  return { status }
}

// ─── StatsService (counters + sys stats) ───────────────────
// Methods: QueryStats (pattern="", reset=false), GetSysStats
export interface StatItem {
  name: string
  value: string | number
}

export interface SysStats {
  Uptime?: string | number
  uptime?: string | number
  NumGoroutine?: string | number
  num_goroutine?: string | number
  Alloc?: string | number
  alloc?: string | number
}

export interface TrafficResult {
  stats: StatItem[]
  sys: SysStats | null
}

export async function queryStats(): Promise<TrafficResult> {
  const StatsService = new grpcProto.xray.app.stats.command.StatsService(
    XRAY_API,
    grpc.credentials.createInsecure()
  )

  let stats: StatItem[] = []
  let sys: SysStats | null = null
  try {
    const qr: any = await unary(
      StatsService,
      'QueryStats',
      { pattern: '', reset: false },
      4000
    )
    stats = (qr?.stat ?? []) as StatItem[]
  } catch {
    stats = []
  }
  try {
    sys = (await unary(
      StatsService,
      'GetSysStats',
      {},
      4000
    )) as SysStats
  } catch {
    sys = null
  }
  return { stats, sys }
}

// ─── Cleanup ────────────────────────────────────────────────
export function closeGrpc(): void {
  if (_channel) {
    _channel.close()
    _channel = null
  }
}
