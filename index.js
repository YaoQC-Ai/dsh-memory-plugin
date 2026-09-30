/**
 * dsh-memory-plugin — L1 短时跨会话记忆（宿主半插件 / host half）
 *
 * 只做一件事：让 agent 在新会话开始时「记得」最近若干会话聊过什么。
 *   捕获 capture —— 已完成轮次（session/event → turn/end），把这一轮的 user+assistant
 *                   文本蒸馏进「按会话 id 分文件」的 Markdown 摘要。
 *   召回 recall  —— 新会话创建（agent/created，source=startup|clear），聚合最近若干会话文件，
 *                   作为背景注入首轮（agent.inject，带 form:'recall'）。resume/compact 不在此重复注入。
 *   淘汰 evict   —— 会话文件超过 maxEntries 时，被挤出的更旧轮次转入 compile_candidates.md
 *                   候选池（P1-1 ④）而非直接丢弃（生产 L2 另读完整事件日志，见 appendCandidates 注）。
 *   恢复 recover —— compaction 可能遮蔽早期背景块；pre-step 修正当前 decision.messages，
 *                   request-error 外层在压缩成功后直接追加日志供同一步 retry 重建。
 *                   不使用恢复注入来唤醒新请求；头部 system/message 由宿主保护。
 *
 * 零依赖、零构建：纯 Node 内置模块 + 内联构造 UserMessage。
 * 防召回污染（2026-09-07 修复）：compile_candidates.md 是「滚动淘汰的旧轮次」候选池，与
 *   会话摘要同目录但**不是会话文件** —— buildDigest 召回时必须排除，否则候选池（常为最新
 *   mtime）会挤占注入预算并把最旧内容当「最近脉络」注入。会话条目边界用「## <ISO 时间戳>」
 *   判定（splitEntries），不按任意 `## ` 切 —— assistant 正文里的 Markdown 标题行（`## xxx`）
 *   不再被误切为新条目（滚动窗口与候选池切块同源一致）。
 * 关键事实（已在 DSH 源码核对，勿凭记忆改动）：
 *   · session.append 只校验 JSON 无损可序列化（isJsonValue），不做逐字段 schema
 *     校验，所以内联冻结字面量 + 新 randomUUID 的注入与 llm.createUserMessage() 等效。
 *   · V4（DSH 0.2 起的会话日志格式）的 admission 要求每条 message 带「生产者自有」的
 *     source.kind；旧的 catch-all `kind: 'plugin'` 会被 session-format-v3-to-v4 直接拒收
 *     （format v4 message requires a producer-owned source kind），整轮运行失败。官方迁移器
 *     把未登记的旧插件生产者写成 `plugin:<name>`，本插件注入与识别统一用该 kind，并继续认得
 *     升级前落盘的 `kind:'plugin' + plugin` 旧形状。注入 source 同时带 `form:'recall'`
 *     （ContextForm 语义：取自别的会话日志、可能已归约），UI 据此渲染成上下文召回行而非用户气泡。
 *   · 0.2 把 `agent/session-start` 改名为 `agent/created`（payload.source ∈ startup|resume|clear|compact）；
 *     同步 inject 稳进首轮（见 packages/hooks/hooks-claude-code 对 agent/created 的用法）。
 *   · 本轮 user/assistant 文本在 session/event 里增量累积（turn/start 起缓冲、turn/end completed 落盘），
 *     不回扫 snapshotEvents()/eventAt()——二者在 0.2 已 @deprecated（禁止新增调用）；surface 是否仍挂着
 *     注入块改用「记录的 seq + 公开 surface.nodes.includes」判定。
 *   · 事件形状不对称（见 packages/core/session/src/types.ts）：
 *       user/message      → data 本身就是 UserMessage     （取 data.content）
 *       assistant/message → data 是 {turn, step, message} （取 data.message.content）
 *       turn/start        → data 是 {turn}
 *   · user/message 里混着 DSH 注入的脚手架（AGENTS.md 工作区指令 / runtime-context 快照 /
 *     skills 目录），它们的 source.kind 各不相同；唯有真实用户 prompt 是 source.kind==='user'
 *     （headless bundle 与 session-controller 均如此，DSH 自身测试也用 source.kind!=='user'
 *     识别注入上下文）。故 turnTextOf 只收 kind==='user'，否则 digest 会被样板塞满并递归放大。
 *
 * 不做（有意推迟，属后续切片）：主题/决定/待办的规则标注（交给 L2 的 LLM 编译）、
 * memory_search 模型工具（memory_save 已在同包 save.js 落地）、向量召回（L3 由 Memorix MCP 提供，见 README）。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'memory-shortterm'

/** V4 生产者自有 kind：与官方 V3→V4 迁移器给未登记插件生产者的形状一致。 */
export const MEMORY_SOURCE_KIND = 'plugin:' + name

/** 默认旋钮；均可被 patch 行的 config 覆盖（见 README）。 */
const DEFAULTS = Object.freeze({
  maxChars: 2048, // 注入摘要的字符上限
  maxEntries: 50, // 每个会话文件保留的轮次条数
  recentFilesCap: 20, // 聚合时最多读取的会话文件数（按 mtime 取最近）
  assistantMaxChars: 280, // 单条助手文本在摘要里的截断长度
  maxCandidates: 500, // compile_candidates.md 候选池最多保留的淘汰块数（防无界增长；P2 编译消费后清理）
})

export function apply(ctx, config = {}) {
  const home = config.dir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const root = path.join(home, 'memory', 'shortterm')
  const maxChars = num(config.maxChars, DEFAULTS.maxChars)
  const maxEntries = num(config.maxEntries, DEFAULTS.maxEntries)
  const recentFilesCap = num(config.recentFilesCap, DEFAULTS.recentFilesCap)
  const assistantMaxChars = num(config.assistantMaxChars, DEFAULTS.assistantMaxChars)
  const maxCandidates = num(config.maxCandidates, DEFAULTS.maxCandidates)

  // 每会话自有状态（P2-1：不再回扫已废弃的 snapshotEvents()/eventAt()，改增量累积 + seq 追踪）。
  const turnBuf = new WeakMap()     // Session -> { turn, parts: string[] }：本轮累积的 user/assistant 文本
  const memorySeq = new WeakMap()   // Session -> 最近一次本插件注入块落 surface 的 seq（供 memoryPresent 判可见）
  const digestCache = new WeakMap() // Session -> 已构建 digest 文本（P2-2：一会话至多扫盘一次）
  const recall = (session) => {
    let text = digestCache.get(session)
    if (text === undefined) {
      text = buildDigest(root, recentFilesCap, maxChars) || ''
      digestCache.set(session, text)
    }
    return text ? userMessage(text, name) : undefined
  }
  const pending = (agent) => agent.inbox.nextStep.filter(isMemory)
  const settle = (agent, messages) => {
    for (const message of messages) agent.inbox.remove(message.id)
  }
  const tracked = (agent) => memorySeq.get(agent.session)

  // P0-1：0.2 把 agent/session-start 改名 agent/created（payload.source ∈ startup|resume|clear|compact）。
  // 只在「全新/清空」的会话面召回注入：resume 已持久化旧注入、compact 交由 pre-step/request-error 恢复路径
  // 重建，二者都不在此重复注入，避免同一会话出现多条 L1 块。
  ctx.on('agent/created', ({ agent, source }) => {
    if (source !== 'startup' && source !== 'clear') return
    try {
      if (memoryPresent(agent, undefined, true, tracked(agent))) return
      const memory = recall(agent.session)
      if (memory) agent.inject(memory)
    } catch (err) {
      ctx.logger(name).warn('recall failed: %s', msg(err))
    }
  })

  // P2-1：增量累积本轮 user/assistant 文本，turn/end completed 时落盘（不回扫事件日志）；
  // 同时记录本插件注入块落 surface 的 seq。历史 seed 不重放这些事件，进程崩溃后的漏捕获不补偿。
  ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'turn/start':
        turnBuf.set(session, { turn: event.data.turn, parts: [] })
        return
      case 'user/message': {
        if (typeof event.seq === 'number' && isMemory(event.data)) memorySeq.set(session, event.seq)
        const buf = turnBuf.get(session)
        if (buf) { const line = turnTextOf(event); if (line) buf.parts.push(line) }
        return
      }
      case 'assistant/message': {
        const buf = turnBuf.get(session)
        if (buf) { const line = turnTextOf(event); if (line) buf.parts.push(line) }
        return
      }
      case 'turn/end': {
        const buf = turnBuf.get(session)
        turnBuf.delete(session)
        if (!buf || buf.turn !== event.data.turn || event.data.reason.kind !== 'completed') return
        try {
          const text = buf.parts.join('\n')
          if (text.trim()) appendEntry(root, sanitize(session.id), text, maxEntries, assistantMaxChars, maxCandidates)
        } catch (err) {
          ctx.logger(name).warn('capture failed: %s', msg(err))
        }
        return
      }
      default:
        return
    }
  })

  // 压缩器跑完后，恢复到当前决定；不把恢复内容留在 nextStep 触发额外请求。
  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next()
    if (signal?.aborted || decision.kind === 'reject'
      || (step === 1 && decision.messages.length === 0)) return decision
    try {
      const queued = pending(agent)
      const memory = memoryPresent(agent, decision.messages, false, tracked(agent)) ? undefined : queued.at(-1) || recall(agent.session)
      settle(agent, queued)
      if (memory) return { ...decision, messages: [...decision.messages, memory] }
    } catch (err) {
      ctx.logger(name).warn('restore failed: %s', msg(err))
    }
    return decision
  }, { prepend: true })

  // 压缩器成功会短路 waterfall：必须在外层等待它结束，再向日志追加供同一步 retry 重建。
  ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    const generation = agent.session.surface.replaceGeneration
    const action = await next()
    if (signal.aborted || action?.kind !== 'retry'
      || failure.code !== 'CONTEXT_WINDOW_EXCEEDED'
      || !(agent.session.surface.replaceGeneration > generation)) return action
    try {
      const queued = pending(agent)
      const memory = memoryPresent(agent, [], false, tracked(agent)) ? undefined : queued.at(-1) || recall(agent.session)
      if (memory) agent.session.append('user/message', memory, { surfaceOp: 'append' })
      settle(agent, queued)
    } catch (err) {
      ctx.logger(name).warn('retry restore failed: %s', msg(err))
    }
    return action // 不授权新重试、不改压缩器计数或 checkpoint。
  }, { prepend: true })
}

// ---------------------------------------------------------------------------
// 纯函数（导出以便零依赖自检；见 test.js）
// ---------------------------------------------------------------------------

/** 零依赖构造 UserMessage：冻结字面量 + 新 id，注入效果等同 llm.createUserMessage()。 */
export function userMessage(text, plugin) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    // kind：V4 生产者自有 kind；form:'recall'：ContextForm 语义标记（跨会话召回），UI 专属渲染。
    source: Object.freeze({ kind: 'plugin:' + plugin, form: 'recall' }),
  })
}

/**
 * 单个事件对「本轮文本」的贡献：真实用户轮 → `[user] …`，助手文本 → `[assistant] …`，无贡献 → ''。
 * user/message 只收 source.kind==='user'（DSH 把 AGENTS.md/runtime-context/skills 也作为 user/message
 * 注入，各自 kind 不同）——白名单而非黑名单，source map 可被插件扩展，黑名单会漏掉新增注入 kind。
 * 增量捕获（session/event）与整段回扫（extractTurn，仅测试/离线用）共用此判定，避免逻辑分叉。
 */
export function turnTextOf(ev) {
  if (!ev) return ''
  if (ev.type === 'user/message') {
    const src = ev.data && ev.data.source
    if (src && src.kind === 'user') {
      const t = textOf(ev.data.content)
      return t ? '[user] ' + t : ''
    }
    return ''
  }
  if (ev.type === 'assistant/message') {
    const t = textOf(ev.data && ev.data.message && ev.data.message.content)
    return t ? '[assistant] ' + t : ''
  }
  return ''
}

/**
 * 抽取「当前这一轮」的 user+assistant 文本：从数组尾部向前扫，遇到 turn/start 即停，正序拼接。
 * 保留此整段回扫版本仅供测试与离线核对；线上捕获走 session/event 增量累积（见 apply）。
 */
export function extractTurn(events) {
  if (!Array.isArray(events)) return ''
  const parts = []
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev && ev.type === 'turn/start') break
    const line = turnTextOf(ev)
    if (line) parts.push(line)
  }
  return parts.reverse().join('\n')
}

/** 从消息 content 块数组里取出纯文本（跳过 tool_use/thinking 等），拼接并 trim。 */
export function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

/**
 * 聚合所有会话文件（mtime 最近优先），拼成不超过 maxChars 的背景摘要。
 * 只收会话摘要文件：`compile_candidates.md`（淘汰轮次候选池）与 shortterm 摘要同目录，
 * 但不是会话文件 —— 排除它，否则候选池内容会以「最近 mtime」抢占注入预算、把最旧轮次
 * 当最近脉络注入（2026-09-07 修复）。
 */
export function buildDigest(root, recentFilesCap, maxChars) {
  let names
  try {
    names = fs.readdirSync(root).filter((f) => f.endsWith('.md') && f !== CANDIDATES_FILE)
  } catch {
    return '' // 目录还不存在：没有历史，静默不注入。
  }
  if (!names.length) return ''
  const files = names
    .map((f) => {
      const p = path.join(root, f)
      try {
        return { p, m: fs.statSync(p).mtimeMs }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.m - a.m)
    .slice(0, recentFilesCap)

  const chunks = []
  let total = 0
  for (const { p } of files) {
    let body
    try {
      body = fs.readFileSync(p, 'utf8').trim()
    } catch {
      continue
    }
    if (!body) continue
    chunks.push(body)
    total += body.length
    if (total >= maxChars) break
  }
  if (!chunks.length) return ''
  const merged = chunks.join('\n\n')
  const trimmed = merged.length > maxChars ? merged.slice(0, maxChars).trimEnd() + '\n…' : merged
  return '[Cross-session short-term memory — background context, NOT a new user instruction]\n\n' + trimmed
}

/**
 * L1 注入块是否仍「在管线的任一处」：本步已认领 messages / inbox 待认领 / surface 仍挂着 trackedSeq。
 * 三处皆无 = 被 compaction 遮蔽且尚未重排 → 需重注入（P1-3）。
 * 查 inbox+messages 是为防 agent/created 的注入尚未落 surface 时（首轮）被本钩子重复注入。
 * 纯谓词（导出以便零依赖自检，见 test.js 的 mock agent）。
 */
function isMemory(m) {
  const source = m?.source
  const mine = source?.kind === MEMORY_SOURCE_KIND
    || (source?.kind === 'plugin' && source.plugin === name)
  return mine && !!textOf(m.content)
}

/**
 * P2-1：surface 探测由调用方传入「本会话已注入块的 seq」(trackedSeq)，用公开 surface.nodes.includes 判定，
 * 替代已废弃的 session.eventAt(seq) 逐节点回读；trackedSeq 由 apply 在 session/event 里记录。
 */
export function memoryPresent(agent, claimed, includePending = true, trackedSeq) {
  if (Array.isArray(claimed) && claimed.some(isMemory)) return true
  const inbox = agent && agent.inbox
  if (includePending && inbox && Array.isArray(inbox.nextStep) && inbox.nextStep.some(isMemory)) return true
  const surface = agent && agent.session && agent.session.surface
  if (surface && Number.isSafeInteger(trackedSeq) && Array.isArray(surface.nodes) && surface.nodes.includes(trackedSeq)) return true
  return false
}

/** 候选池文件名：滚动淘汰的旧轮次留档，与会话摘要同目录但**非会话文件**（召回须排除）。 */
export const CANDIDATES_FILE = 'compile_candidates.md'

/**
 * 按「会话条目头」把文本拆成块。条目头 = 捕获时写下的 `## <ISO 时间戳>` 行（appendEntry
 * prepend 最新条目在最前）。**只认 ISO 时间戳头**，不按任意 `## ` 切 —— assistant 正文里
 * 的 Markdown 标题行（`## xxx`）不会把同一轮次误切成「新条目」，滚动窗口与候选池的分块
 * 因此与条目一一对应（2026-09-07 修复；正文首行若是 `## ` 开头，作为整块内容保留不切）。
 * 导出的正则供 appendCandidates 同源使用。
 */
export const ENTRY_HEAD_RE = /^## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * 按 `## ` 块把 text 拆成「保留的最新 maxEntries 块」与「被淘汰的更旧块」。
 * 会话文件是新条目 prepend 在最前，故 kept=前 maxEntries 块（最新），evicted=其余（更旧）；
 * 未超限时 evicted 为空串。导出以便零依赖自检（见 test.js）。
 */
export function splitCap(text, maxEntries) {
  const blocks = splitEntries(text)
  if (blocks.length <= maxEntries) return { kept: text, evicted: '' }
  return { kept: blocks.slice(0, maxEntries).join('\n'), evicted: blocks.slice(maxEntries).join('\n') }
}

/** 按条目头切分（splitCap 与候选池共用的同源实现）。文本为空或无法识别任何条目头 → 整段返回。 */
export function splitEntries(text) {
  if (typeof text !== 'string' || !text.trim()) return []
  const heads = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (ENTRY_HEAD_RE.test(line)) {
      heads.push(i)
    }
  })
  if (!heads.length) return [text]
  const blocks = []
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h]
    const end = h + 1 < heads.length ? heads[h + 1] : lines.length
    blocks.push(lines.slice(start, end).join('\n'))
  }
  return blocks
}

/** 只保留最新的 maxEntries 个 `## ` 块（= splitCap 的 kept 半；保留此薄封装兼容旧调用/测试）。 */
export function capEntries(text, maxEntries) {
  return splitCap(text, maxEntries).kept
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function appendEntry(root, id, text, maxEntries, assistantMaxChars, maxCandidates) {
  const body = text
    .split('\n')
    .map((line) =>
      line.startsWith('[assistant] ') && line.length > assistantMaxChars
        ? line.slice(0, assistantMaxChars) + '…'
        : line,
    )
    .join('\n')
  const entry = `## ${new Date().toISOString()}\n${body}`
  let existing = ''
  try {
    existing = fs.readFileSync(path.join(root, id + '.md'), 'utf8')
  } catch {
    // 首次写入：没有旧内容。
  }
  fs.mkdirSync(root, { recursive: true })
  const { kept, evicted } = splitCap(entry + '\n\n' + existing, maxEntries)
  fs.writeFileSync(path.join(root, id + '.md'), kept)
  // ④ 滚动淘汰：被挤出会话文件的更旧轮次转入候选池，而非直接丢弃。
  if (evicted.trim()) appendCandidates(root, evicted, maxCandidates)
}

/**
 * 把淘汰块追加进 shortterm/compile_candidates.md（全会话共享一个候选池）。
 * 格式与会话文件一致（`## <ISO 时间>\n<正文>`），clean_candidates.py 按 `## ` 分块消费。
 * 注：生产版 L2（P2-1 memory_compile）直接读完整会话事件日志，本候选池主要作人可读的
 * 「L1 已老化轮次」留存 + 离线骨架输入，非 L2 唯一权威来源；池按 maxCandidates 保留最近
 * 淘汰的块，防无界增长（P2 编译消费后可清理）。
 */
function appendCandidates(root, evicted, maxCandidates) {
  const p = path.join(root, 'compile_candidates.md')
  let existing = ''
  try {
    existing = fs.readFileSync(p, 'utf8')
  } catch {
    // 首次：候选池还不存在。
  }
  const merged = (existing.trim() ? existing.trimEnd() + '\n\n' : '') + evicted.trim()
  // 与 splitCap 同源按「条目头」切（正文里的 Markdown `## ` 不误切），保最近 maxCandidates 块。
  const blocks = splitEntries(merged)
  const capped = blocks.length > maxCandidates ? blocks.slice(blocks.length - maxCandidates).join('\n') : merged
  fs.writeFileSync(p, capped + '\n')
}

/** 会话 id → 安全文件名。 */
function sanitize(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'session'
}

function num(v, d) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d
}

function msg(e) {
  return e && e.message ? e.message : String(e)
}
