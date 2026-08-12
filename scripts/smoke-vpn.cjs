#!/usr/bin/env node
/**
 * Standalone smoke: xray survival + SOCKS egress (no Electron UI).
 * Usage: node scripts/smoke-vpn.cjs
 */
const { spawn, execFile } = require('child_process')
const path = require('path')
const fs = require('fs')

const USER_DATA = process.env.VOID_SHIELD_USER_DATA ||
  path.join(process.env.HOME || '/tmp', '.config', 'void-shield')
const XRAY = path.join(USER_DATA, 'bin', 'xray')
const CFG = path.join(USER_DATA, 'xray-config.json')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function probeEgress() {
  return new Promise((resolve) => {
    execFile(
      'curl',
      ['-4', '-sS', '--max-time', '5', '-x', 'socks5h://127.0.0.1:7893', 'https://api.ipify.org'],
      { encoding: 'utf8', timeout: 8000 },
      (err, out) => resolve(err ? '' : out.trim())
    )
  })
}

async function main() {
  if (!fs.existsSync(CFG)) {
    console.error('SMOKE_FAIL: missing', CFG)
    process.exit(1)
  }
  if (!fs.existsSync(XRAY)) {
    console.error('SMOKE_FAIL: missing', XRAY)
    process.exit(1)
  }
  const proc = spawn(XRAY, ['run', '-c', CFG], { stdio: ['ignore', 'pipe', 'pipe'] })
  let exitCode = null
  proc.on('exit', (c) => { exitCode = c })
  let lastIp = ''
  for (let i = 1; i <= 12; i++) {
    await sleep(5000)
    const alive = exitCode === null && !proc.killed
    const ip = alive ? await probeEgress() : ''
    if (ip) lastIp = ip
    console.log(`SMOKE t=${i * 5}s alive=${alive} egress=${ip || 'DOWN'}`)
    if (!alive) {
      console.error('SMOKE_FAIL: xray died (code=' + exitCode + ')')
      process.exit(1)
    }
  }
  try { proc.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(1000)
  if (!lastIp) {
    console.error('SMOKE_FAIL: no egress IP')
    process.exit(1)
  }
  console.log('SMOKE_OK: 60s alive egress=' + lastIp)
  process.exit(0)
}

main().catch((e) => {
  console.error('SMOKE_FAIL', e)
  process.exit(1)
})
