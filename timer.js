/**
 * dsh-memory-plugin — memory-timer 每日定时载体（P1-4 / K4 自研墙钟轮询）
 *
 * 只做一件事：每天到点（默认 02:00 本地墙钟）触发一次「每日任务」。P1-4 阶段任务体是
 * dry-run（只在 _log.md 记一行触发凭证）；P2-1 把 dryRun 换成 memory-compile 的真实增量编译。
 * 它是 L2 编译的「闹钟」，本身不碰编译逻辑。
 *
 * 机制（K4 定案 + P1-4 源码复核）：
 *   轮询 poll —— ctx.interval(tick, pollMs) 每 pollMs（默认 60s）比对墙钟；base 默认挂载
 *                @deepseek-ai/cordis-plugin-timer（bundle/base/cordis.patch.yml:15），disposal-aware
 *                （vendor/timer/src/index.ts：ctx.effect 包 setInterval，fiber 卸载自动 clearInterval）。
 *   边界 boundary —— dueBoundary(now) = 「≤now 的最近一次 hour:minute 本地墙钟点」；本地时区
 *                （setHours），因为「每晚 02:00」是机器本地语义。
 *   触发判定 shouldFire —— boundary > lastRun 即到期。天然覆盖三态：① 正常跨 02:00；② 休眠/关机
 *                错过后开机补跑一次（boot 立即 tick + boundary 仍是今天 02:00 > 昨天 lastRun）；
 *                ③ 触发后同一天重启不重复（lastRun=今天 02:05 ≥ boundary 今天 02:00）。
 *   补跑 catch-up —— apply 里先同步 tick() 一次，再挂 interval：开机即补跑，不必等首个 pollMs。
 *
 * 状态持久化：用 memory root 下的 timer-state.json（node:fs），保持同步、零依赖、人可读。
 *   同目录临时文件写完后替换；不提供跨进程互斥，也不保证日志与状态的跨文件事务。
 *   保存 lastRun、结果与失败计数；nextRun 由墙钟实时计算。
 *
 * 失败告警（FR-5.2）：每个 boundary 只尝试一次（lastRun 成功/失败都推进，不做同夜内轮询重试刷屏）；
 *   consecutiveFailures 跨夜累计、成功即清零；达到 failAlertThreshold（默认 2）→ ctx.logger.warn 告警。
 *
 * 零依赖、零构建：纯 Node 内置模块。tick 全同步（dry-run 是同步 fs）；P2-1 换真实 async 编译时，
 *   tick 需转 async 并加「重入守卫」（编译可能 >pollMs），此处有意不预建（YAGNI）。
 */
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export const name = 'memory-timer'
export const inject = ['timer'] // 需 ctx.interval（timer Service mixin）；对齐 save.js 的 inject=['tools']。

/** 默认旋钮；均可被 patch 行的 config 覆盖（见 README）。 */
const DEFAULTS = Object.freeze({
  hour: 2, // 每日触发的小时（本地墙钟，0-23；K5：02:00，可配不写死）
  minute: 0, // 每日触发的分钟（0-59）
  pollMs: 60_000, // ctx.interval 轮询周期
  failAlertThreshold: 2, // 连续失败几晚后告警（FR-5.2）
})

export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  // ponytail: 只允许一个进程启用 timer；真实异步编译上线时再引入跨进程互斥。
  const home = config.dir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const memRoot = path.join(home, 'memory')
  const statePath = path.join(memRoot, 'timer-state.json')
  const logPath = path.join(memRoot, '_log.md')
  const hour = intOr(config.hour, DEFAULTS.hour, 0, 23)
  const minute = intOr(config.minute, DEFAULTS.minute, 0, 59)
  const pollMs = posIntOr(config.pollMs, DEFAULTS.pollMs)
  const failAlertThreshold = posIntOr(config.failAlertThreshold, DEFAULTS.failAlertThreshold)
  const log = ctx.logger(name)

  const tick = () => {
    try {
      const now = new Date()
      const state = readState(statePath)
      const lastRun = state.lastRun ? Date.parse(state.lastRun) : undefined
      if (!shouldFire(lastRun, now, hour, minute)) return // 未到期：no-op。
      const boundary = dueBoundary(now, hour, minute).toISOString()
      try {
        // P1-4 任务体 = dry-run（记录触发凭证）；P2-1 在此换成 memory-compile 真实增量编译。
        dryRun(logPath, now, boundary)
        writeState(statePath, recordSuccess(now, boundary))
        log.info('timer fired (dry-run) for boundary %s', boundary)
      } catch (err) {
        const next = recordFailure(state, now, boundary, msg(err))
        writeState(statePath, next)
        if (shouldAlert(next, failAlertThreshold)) {
          log.warn('timer task failed %d consecutive times (>= %d), FR-5.2 alert: %s', next.consecutiveFailures, failAlertThreshold, msg(err))
        } else {
          log.warn('timer task failed: %s', msg(err))
        }
      }
    } catch (err) {
      log.warn('timer tick error: %s', msg(err))
    }
  }

  tick() // 启动即补跑一次（shouldFire 守卫；未到期为 no-op）——覆盖休眠/关机错过 02:00 的开机补跑。
  ctx.interval(tick, pollMs) // disposal-aware：fiber 卸载时自动 clearInterval（见头注）。
}

// ---------------------------------------------------------------------------
// 纯函数（导出以便零依赖自检；见 timer.test.js）
// ---------------------------------------------------------------------------

/**
 * ≤now 的最近一次「hour:minute 本地墙钟点」。若今天的该时刻仍在未来，则回退到昨天。
 * 用本地时区（setHours）——「每晚 02:00」是机器本地语义，非 UTC。返回新 Date（不改入参）。
 */
export function dueBoundary(now, hour, minute) {
  const d = new Date(now.getTime())
  d.setHours(hour, minute, 0, 0)
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1)
  return d
}

/** 是否到期：最近的边界严格晚于上次运行时刻（lastRun 缺失=从未运行 → 到期，覆盖首装/补跑）。 */
export function shouldFire(lastRunMs, now, hour, minute) {
  const boundary = dueBoundary(now, hour, minute).getTime()
  return boundary > (Number.isFinite(lastRunMs) ? lastRunMs : -Infinity)
}

/** 读状态文件；缺失/损坏 → 空对象（当作从未运行，下次 tick 会补跑一次）。 */
export function readState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 同目录临时文件替换，写失败不截断旧状态；不等于日志+状态的跨文件事务。 */
export function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  const temp = `${statePath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' })
    fs.renameSync(temp, statePath)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}

/**
 * P1-4 任务体：dry-run —— 在 _log.md 追加一行触发凭证（跨 2 天观察的可审计证据）。
 * P2-1 用真实 memory-compile 增量编译替换本函数体（届时改为 async）。
 */
export function dryRun(logPath, now, boundaryIso) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `- ${now.toISOString()} [memory-timer] dry-run fired (boundary ${boundaryIso})\n`)
}

/** 成功后的新状态：consecutiveFailures 清零（FR-5.2）。 */
export function recordSuccess(now, boundaryIso) {
  return { lastRun: now.toISOString(), lastResult: 'ok', consecutiveFailures: 0, lastBoundary: boundaryIso }
}

/** 失败后的新状态：consecutiveFailures 在上一状态基础上 +1（跨夜累计，FR-5.2）。 */
export function recordFailure(prev, now, boundaryIso, errMsg) {
  const n = (prev && Number.isFinite(prev.consecutiveFailures) ? prev.consecutiveFailures : 0) + 1
  return { lastRun: now.toISOString(), lastResult: 'error', consecutiveFailures: n, lastError: errMsg, lastBoundary: boundaryIso }
}

/** 是否达到告警阈值（FR-5.2：连续 failAlertThreshold 晚失败）。 */
export function shouldAlert(state, threshold) {
  const n = state && Number.isFinite(state.consecutiveFailures) ? state.consecutiveFailures : 0
  return n >= threshold
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 整数且落在 [lo,hi] 才接受，否则用默认（hour 允许 0，故不能用只判 >0 的 num）。 */
function intOr(v, d, lo, hi) {
  return Number.isInteger(v) && v >= lo && v <= hi ? v : d
}

/** 正整数才接受，否则用默认。 */
function posIntOr(v, d) {
  return Number.isInteger(v) && v > 0 ? v : d
}

function msg(e) {
  return e && e.message ? e.message : String(e)
}
