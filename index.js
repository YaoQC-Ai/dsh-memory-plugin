/**
 * dsh-memory-plugin — L1 短时跨会话记忆（宿主半插件 / host half）
 *
 * 只做一件事：让 agent 在新会话开始时「记得」最近若干会话聊过什么。
 *   捕获 capture —— 每轮结束（agent/turn-stopping），把这一轮的 user+assistant
 *                   文本蒸馏进「按会话 id 分文件」的 Markdown 摘要。
 *   召回 recall  —— 每次会话开始（agent/session-start），聚合最近若干会话文件，
 *                   作为背景注入首轮（agent.inject）。
 *   淘汰 evict   —— 会话文件超过 maxEntries 时，被挤出的更旧轮次转入 compile_candidates.md
 *                   候选池（P1-1 ④）而非直接丢弃（生产 L2 另读完整事件日志，见 appendCandidates 注）。
 *   恢复 recover —— compaction 从 surface 第 0 节点起「头部锚定」压缩，注入在会话最前部的
 *                   背景块必被移出可见 surface；每步（agent/pre-step）检查它是否仍可见，被遮蔽
 *                   则重排（P1-3，对标 agent-instructions 基线恢复；见 apply 内 pre-step 注）。
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
 *   · 同步 inject 稳进首轮（见 packages/hooks/hooks-claude-code 的 session-start 注释）。
 *   · 本轮事件用 agent.session.snapshotEvents() 读——Session 事件存私有 log，无公开
 *     .events 属性（写成 .events 会是 undefined，导致 turn-stopping 静默不捕获；已在
 *     真实 headless 会话踩到并修复）。
 *   · 事件形状不对称（见 packages/core/session/src/types.ts）：
 *       user/message      → data 本身就是 UserMessage     （取 data.content）
 *       assistant/message → data 是 {turn, step, message} （取 data.message.content）
 *       turn/start        → data 是 {turn}
 *   · user/message 里混着 DSH 注入的脚手架（AGENTS.md 工作区指令 / runtime-context 快照 /
 *     skills 目录），它们的 source.kind 各不相同；唯有真实用户 prompt 是 source.kind==='user'
 *     （headless bundle 与 session-controller 均如此，DSH 自身测试也用 source.kind!=='user'
 *     识别注入上下文）。故 extractTurn 只收 kind==='user'，否则 digest 会被样板塞满并递归放大。
 *
 * 不做（有意推迟，属后续切片）：主题/决定/待办的规则标注（交给 L2 的 LLM 编译）、
 * memory_search 模型工具（memory_save 已在同包 save.js 落地）、向量召回（L3 由 Memorix MCP 提供，见 README）。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'memory-shortterm'

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

  // 召回：任何来源的 session-start（startup|resume|clear|compact）都注入最近脉络。
  ctx.on('agent/session-start', ({ agent }) => {
    try {
      const digest = buildDigest(root, recentFilesCap, maxChars)
      if (digest) agent.inject(userMessage(digest, name))
    } catch (err) {
      ctx.logger(name).warn('recall failed: %s', msg(err))
    }
  })

  // 捕获：每轮结束把 user+assistant 文本写进本会话文件（分文件避免并发写竞态）。
  ctx.on('agent/turn-stopping', ({ agent }) => {
    try {
      // 事件在 Session 私有 log 里，公开访问器是 snapshotEvents()（无 .events 属性）。
      const text = extractTurn(agent.session.snapshotEvents())
      if (text.trim()) appendEntry(root, sanitize(agent.id), text, maxEntries, assistantMaxChars, maxCandidates)
    } catch (err) {
      ctx.logger(name).warn('capture failed: %s', msg(err))
    }
  })

  // 恢复（P1-3）：compaction 后重注入 L1 脉络。关键事实（DSH 源码已核，勿凭记忆改）：
  //   · session-start 的 source='compact' 在 DSH「保留但无发射方」(core/agent/README:179)，
  //     compaction 不重发 session-start → K10 原设想挂点不存在，改挂 agent/pre-step。
  //   · compaction-basic 自身就在 agent/pre-step 里 next() 之前跑 compactIfNeeded（head-anchored，
  //     region.ts selectCompactableRange start=surfaceNodes[0]）；故本钩子在 await next() 之后检查，
  //     无论注册先后都能看到「已遮蔽」的 surface，同步骤检测、重排到 inbox（下一步生效）。
  //   · compaction 只遮蔽 surface、不删事件日志 → turn-stopping 的 snapshotEvents 捕获天然免疫，
  //     且 compactNow 要求 idle（末轮已 turn-stopping 落盘）→ K10 part(a)「flush 未写回合」无必要。
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision // 本步不跑模型：无需恢复，留待下个非 reject 步。
    try {
      if (memoryPresent(agent, messages)) return decision // 仍在（surface/inbox/本步已认领）：不动。
      const digest = buildDigest(root, recentFilesCap, maxChars) // 被遮蔽：重建并排队（每步至多一次，落地即停）。
      if (digest) agent.inject(userMessage(digest, name))
    } catch (err) {
      ctx.logger(name).warn('re-inject failed: %s', msg(err))
    }
    return decision
  })
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
    source: Object.freeze({ kind: 'plugin', plugin }),
  })
}

/**
 * 抽取「当前这一轮」的 user+assistant 文本。
 * 从日志尾部向前扫，遇到 turn/start 即停 —— turn-stopping 触发时尾部就是本轮。
 * 返回按时间正序拼接的多行文本。
 */
export function extractTurn(events) {
  if (!Array.isArray(events)) return ''
  const parts = []
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (!ev) continue
    if (ev.type === 'turn/start') break
    if (ev.type === 'user/message') {
      // 只收真实用户轮：source.kind==='user'。DSH 把 AGENTS.md/runtime-context/skills 也作为
      // user/message 注入，但各自 kind 不同（agent-instructions/skill-catalog/plugin…）。
      // 白名单而非黑名单——source map 可被插件扩展，黑名单会漏掉新增的注入 kind。
      const src = ev.data && ev.data.source
      if (src && src.kind === 'user') {
        const t = textOf(ev.data.content)
        if (t) parts.push('[user] ' + t)
      }
    } else if (ev.type === 'assistant/message') {
      const t = textOf(ev.data && ev.data.message && ev.data.message.content)
      if (t) parts.push('[assistant] ' + t)
    }
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
 * L1 注入块是否仍「在管线的任一处」：本步已认领 messages / inbox 待认领 / surface 已落。
 * 三处皆无 = 被 compaction 遮蔽且尚未重排 → 需重注入（P1-3）。
 * 查 inbox+messages 是为防 session-start 的注入尚未落 surface 时（首轮）被本钩子重复注入。
 * 纯谓词（导出以便零依赖自检，见 test.js 的 mock agent）。
 */
export function memoryPresent(agent, claimed) {
  const isMine = (m) => !!m && m.source && m.source.kind === 'plugin' && m.source.plugin === name
  if (Array.isArray(claimed) && claimed.some(isMine)) return true
  const inbox = agent && agent.inbox
  if (inbox && Array.isArray(inbox.nextStep) && inbox.nextStep.some(isMine)) return true
  const session = agent && agent.session
  const surface = session && session.surface
  if (surface && Array.isArray(surface.nodes)) {
    for (const seq of surface.nodes) {
      const ev = session.eventAt(seq)
      if (ev && ev.type === 'user/message' && isMine(ev.data)) return true
    }
  }
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
  let lastHead = -1
  lines.forEach((line, i) => {
    if (ENTRY_HEAD_RE.test(line)) {
      heads.push(i)
      lastHead = i
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
