/**
 * 零依赖自检：node --test（timer.js 的纯逻辑 + apply 接线）
 *
 * 覆盖 memory-timer 的非平凡逻辑 —— dueBoundary 的本地墙钟边界（今天/昨天）、shouldFire 的五种
 * 时序态（首装/刚跑过/昨天 lastRun/休眠补跑/跑后重启）、state 读写 round-trip、dryRun 落盘、
 * FR-5.2 的失败跨夜累计+成功清零+阈值告警；以及 apply 用假 ctx 跑通「到期立即补跑 → 落 _log.md+state
 * → 注册 interval」与「未到期不触发」。全部时区鲁棒（用本地 Date 构造器两边同解释，不硬编码 epoch ms），
 * 不碰真实 DSH（ctx.interval/logger 用假对象）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  name, inject, apply,
  dueBoundary, shouldFire, readState, writeState, dryRun,
  recordSuccess, recordFailure, shouldAlert,
} from './timer.js'

test('导出契约：name=memory-timer，inject=[timer]（需 ctx.interval）', () => {
  assert.equal(name, 'memory-timer')
  assert.deepEqual(inject, ['timer'])
})

test('dueBoundary 本地墙钟：now 在边界后→今天该刻，now 在边界前→昨天该刻', () => {
  const after = new Date(2026, 8, 5, 10, 30, 0) // 本地 09-05 10:30，已过 02:00
  assert.equal(dueBoundary(after, 2, 0).getTime(), new Date(2026, 8, 5, 2, 0, 0).getTime())
  const before = new Date(2026, 8, 5, 1, 0, 0) // 本地 09-05 01:00，未到 02:00
  assert.equal(dueBoundary(before, 2, 0).getTime(), new Date(2026, 8, 4, 2, 0, 0).getTime())
  // 不改入参
  assert.equal(after.getTime(), new Date(2026, 8, 5, 10, 30, 0).getTime())
})

test('shouldFire 五态：首装/刚跑过/昨天lastRun/休眠补跑/跑后重启', () => {
  const now = new Date(2026, 8, 5, 10, 30, 0) // 本地 09-05 10:30
  // ① 首装（无 lastRun）→ 到期（补跑一次）
  assert.equal(shouldFire(undefined, now, 2, 0), true)
  // ② 刚跑过（lastRun=今天 02:05，边界=今天 02:00）→ 不重复
  assert.equal(shouldFire(new Date(2026, 8, 5, 2, 5, 0).getTime(), now, 2, 0), false)
  // ③ 昨天跑过（lastRun=昨天 02:05）+ 今天已过 02:00 → 到期
  assert.equal(shouldFire(new Date(2026, 8, 4, 2, 5, 0).getTime(), now, 2, 0), true)
  // ④ 休眠补跑（lastRun=两天前）+ now=今天 10:00 → 到期（补跑一次）
  assert.equal(shouldFire(new Date(2026, 8, 3, 2, 5, 0).getTime(), new Date(2026, 8, 5, 10, 0, 0), 2, 0), true)
  // ⑤ 跑后同日重启（lastRun=今天 02:05，now=今天 02:06）→ 不重复
  assert.equal(shouldFire(new Date(2026, 8, 5, 2, 5, 0).getTime(), new Date(2026, 8, 5, 2, 6, 0), 2, 0), false)
})

test('state round-trip：writeState→readState 保真；缺失/损坏→{}', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-timer-'))
  const p = path.join(dir, 'memory', 'timer-state.json')
  assert.deepEqual(readState(p), {}) // 尚不存在
  const s = recordSuccess(new Date(2026, 8, 5, 2, 0, 5), '2026-09-05T02:00:00.000Z')
  writeState(p, s) // 自动建 memory/ 目录
  assert.deepEqual(readState(p), s)
  fs.writeFileSync(p, '{ 坏 JSON') // 损坏 → {}
  assert.deepEqual(readState(p), {})
})

test('dryRun 追加触发凭证到 _log.md（不存在则创建，多次追加累计）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-log-'))
  const logPath = path.join(dir, 'memory', '_log.md')
  dryRun(logPath, new Date(2026, 8, 5, 2, 0, 5), '2026-09-05T02:00:00.000Z')
  dryRun(logPath, new Date(2026, 8, 6, 2, 0, 5), '2026-09-06T02:00:00.000Z')
  const body = fs.readFileSync(logPath, 'utf8')
  assert.equal((body.match(/\[memory-timer\] dry-run fired/g) || []).length, 2)
  assert.ok(body.includes('boundary 2026-09-05T02:00:00.000Z'))
  assert.ok(body.includes('boundary 2026-09-06T02:00:00.000Z'))
})

test('FR-5.2：失败跨夜累计、成功清零、阈值告警', () => {
  const now = new Date(2026, 8, 5, 2, 0, 5)
  const b = '2026-09-05T02:00:00.000Z'
  const f1 = recordFailure({}, now, b, 'boom1') // 第一晚失败
  assert.equal(f1.consecutiveFailures, 1)
  assert.equal(shouldAlert(f1, 2), false)
  const f2 = recordFailure(f1, now, b, 'boom2') // 第二晚失败（累计）
  assert.equal(f2.consecutiveFailures, 2)
  assert.equal(f2.lastResult, 'error')
  assert.equal(f2.lastError, 'boom2')
  assert.equal(shouldAlert(f2, 2), true) // 达到阈值 → 告警
  const ok = recordSuccess(now, b) // 成功 → 清零
  assert.equal(ok.consecutiveFailures, 0)
  assert.equal(ok.lastResult, 'ok')
  assert.equal(shouldAlert(ok, 2), false)
})

// 集成：假 ctx + 临时 home，跑通 apply 的「到期立即补跑」与「未到期不触发」。
test('apply: 到期（首装无 state）→ 立即 tick 落 _log.md+state，并注册 interval', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-apply-due-'))
  const intervals = []
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    interval: (cb, ms) => { intervals.push({ cb, ms }); return () => {} },
  }
  apply(ctx, { dir, hour: 2, minute: 0 }) // 首装无 state → shouldFire 恒真 → 立即补跑

  assert.equal(intervals.length, 1, '应注册一次 ctx.interval')
  assert.equal(intervals[0].ms, 60_000, '默认轮询周期 60s')
  assert.equal(typeof intervals[0].cb, 'function')
  const logPath = path.join(dir, 'memory', '_log.md')
  const statePath = path.join(dir, 'memory', 'timer-state.json')
  assert.ok(fs.existsSync(logPath), 'dry-run 应落 _log.md')
  assert.ok(fs.readFileSync(logPath, 'utf8').includes('[memory-timer] dry-run fired'))
  const st = readState(statePath)
  assert.equal(st.lastResult, 'ok')
  assert.equal(st.consecutiveFailures, 0)
  assert.ok(st.lastRun && st.lastBoundary)
})

test('apply: 未到期（lastRun=now）→ 不触发，但仍注册 interval', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-apply-idle-'))
  const memRoot = path.join(dir, 'memory')
  fs.mkdirSync(memRoot, { recursive: true })
  writeState(path.join(memRoot, 'timer-state.json'), { lastRun: new Date().toISOString(), lastResult: 'ok', consecutiveFailures: 0 })
  const intervals = []
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    interval: (cb, ms) => { intervals.push({ cb, ms }); return () => {} },
  }
  apply(ctx, { dir, hour: 2, minute: 0 }) // lastRun=now ≥ boundary → shouldFire 假 → 立即 tick no-op

  assert.equal(intervals.length, 1, 'interval 仍应注册（等下一个边界）')
  assert.equal(fs.existsSync(path.join(memRoot, '_log.md')), false, '未到期不应落 _log.md')
})
