/**
 * 零依赖自检：node --test
 *
 * 覆盖 L1 的非平凡逻辑 —— extractTurn 的反向扫描 + 事件形状不对称、
 * textOf 的块过滤、capEntries 的裁剪、userMessage 的内联契约、
 * memoryPresent 的三处可见性 + pre-step compaction 恢复重注入（P1-3）、
 * buildDigest 排除候选池（P1-1 防污染修复）、splitEntries 条目边界（P2-1 修复）。
 * 不碰真实 DSH；文件系统仅在临时目录（apply 集成用例与 buildDigest 回归用例）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, extractTurn, textOf, capEntries, splitCap, splitEntries, userMessage, memoryPresent, buildDigest, CANDIDATES_FILE } from './index.js'

// 把旧文本 fixture 包成宿主真实的完成事件；不把 turn-stopping 当作结束。
function completed(handlers) {
  return ({ agent }) => {
    agent.session.id = agent.id
    const events = agent.session.snapshotEvents()
    handlers['session/event'](agent.session, {
      type: 'turn/end', seq: events.length,
      data: { turn: events.findLast((ev) => ev.type === 'turn/start').data.turn, reason: { kind: 'completed' } },
    })
  }
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-compat-'))
  const root = path.join(dir, 'memory', 'shortterm')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'history.md'), '已确认的测试事实')
  const handlers = {}, options = {}, warnings = []
  apply({ on: (e, fn, opts) => { handlers[e] = fn; options[e] = opts }, logger: () => ({ warn: (...v) => warnings.push(v) }) }, { dir })
  const events = []
  const agent = {
    inbox: { nextStep: [], remove(id) { this.nextStep = this.nextStep.filter((m) => m.id !== id) } },
    session: {
      id: 'compat', surface: { nodes: [], replaceGeneration: 0 },
      eventAt: (seq) => events[seq], snapshotEvents: () => [...events],
      append(type, data, opts) {
        const event = { type, data, seq: events.length }
        events.push(event)
        if (opts?.surfaceOp === 'append') this.surface.nodes.push(event.seq)
        handlers['session/event'](this, event)
        return event
      },
    },
    inject(m) { this.inbox.nextStep.push(m) },
  }
  return { dir, handlers, options, agent, events, warnings }
}

test('resume 检查 surface 与持久化 inbox，重复启动不增加注入', () => {
  const { handlers, agent } = fixture()
  handlers['agent/session-start']({ agent })
  handlers['agent/session-start']({ agent })
  assert.equal(agent.inbox.nextStep.length, 1)
  const memory = agent.inbox.nextStep.pop()
  agent.session.append('user/message', memory, { surfaceOp: 'append' })
  handlers['agent/session-start']({ agent })
  assert.equal(agent.inbox.nextStep.length, 0)
})

test('pre-step 保留最终决定字段、消费 pending，空首步/reject/取消不恢复', async () => {
  const { handlers, agent } = fixture()
  const hook = handlers['agent/pre-step']
  const memory = userMessage('pending', 'memory-shortterm')
  const other = userMessage('peer', 'peer')
  agent.inbox.nextStep.push(memory, other)
  const empty = { kind: 'enter', messages: [], startsRequestSeries: true }
  assert.equal(await hook({ agent, step: 1 }, async () => empty), empty)
  assert.equal(agent.inbox.nextStep.length, 2)
  const rejected = { kind: 'reject' }
  assert.equal(await hook({ agent, step: 2 }, async () => rejected), rejected)
  assert.equal(await hook({ agent, step: 2, signal: { aborted: true } }, async () => empty), empty)
  const decision = await hook({ agent, step: 2 }, async () => empty)
  assert.equal(decision.startsRequestSeries, true)
  assert.deepEqual(decision.messages, [memory])
  assert.deepEqual(agent.inbox.nextStep, [other])
  // 下游已放入记忆，应保留该决定，并清理多余 pending。
  agent.inbox.nextStep.push(memory)
  assert.equal(await hook({ agent, step: 2 }, async () => decision), decision)
  assert.deepEqual(agent.inbox.nextStep, [other])
})

test('turn/end 只捕获 completed 一次，取消/错误/空轮次跳过', () => {
  const { handlers, agent, dir } = fixture()
  assert.equal(handlers['agent/turn-stopping'], undefined)
  const s = agent.session
  s.append('turn/start', { turn: 1 })
  s.append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '完整轮次' }] })
  s.append('assistant/message', { message: { content: [{ type: 'text', text: '延长后完成' }] } })
  const end = s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  handlers['session/event'](s, end)
  const file = path.join(dir, 'memory', 'shortterm', 'compat.md')
  const first = fs.readFileSync(file, 'utf8')
  assert.equal(splitEntries(first).length, 1)
  assert.match(first, /延长后完成/)
  let turn = 2
  for (const kind of ['aborted', 'error', 'blocked', 'max-tokens', 'interrupted']) {
    s.append('turn/start', { turn })
    s.append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '未完成' }] })
    s.append('turn/end', { turn: turn++, reason: { kind } })
  }
  s.append('turn/start', { turn })
  s.append('turn/end', { turn, reason: { kind: 'completed' } })
  assert.equal(fs.readFileSync(file, 'utf8'), first)
})

test('溢出重试外层恢复日志：保留 action、无 inbox 遗留、不自授权重试', async () => {
  for (const mode of ['retry', 'terminal', 'no-progress', 'cancel', 'disposed', 'other-code', 'write-error']) {
    const { handlers, options, agent, warnings } = fixture()
    const hook = handlers['agent/request-error']
    assert.equal(options['agent/request-error'].prepend, true)
    const signal = { aborted: false }
    const action = mode === 'terminal' ? undefined : { kind: 'retry', peer: true }
    const memory = userMessage('pending', 'memory-shortterm')
    agent.inbox.nextStep.push(memory)
    let calls = 0
    const result = await hook({ agent, signal, failure: { code: mode === 'other-code' ? 'OTHER' : 'CONTEXT_WINDOW_EXCEEDED' } }, async () => {
      calls++
      if (mode !== 'no-progress') agent.session.surface.replaceGeneration++
      if (mode === 'cancel') signal.aborted = true
      if (mode === 'disposed') handlers.dispose()
      if (mode === 'write-error') agent.session.append = () => { throw new Error('disk failure') }
      return action
    })
    assert.equal(calls, 1)
    assert.equal(result, action)
    assert.equal(agent.session.surface.nodes.length, mode === 'retry' ? 1 : 0)
    assert.equal(agent.inbox.nextStep.length, mode === 'retry' ? 0 : 1)
    assert.equal(warnings.length, mode === 'write-error' ? 1 : 0)
  }
})

test('textOf 只保留 text 块并 trim', () => {
  assert.equal(
    textOf([{ type: 'text', text: ' a ' }, { type: 'tool_use' }, { type: 'text', text: 'b' }]),
    'a\nb',
  )
  assert.equal(textOf(undefined), '')
  assert.equal(textOf('not-an-array'), '')
  assert.equal(textOf([{ type: 'thinking', text: 'x' }]), '')
})

test('extractTurn 在 turn/start 处停住，并解包 assistant.message', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'hello' }] } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'bye' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { turn: 2, step: 0, message: { content: [{ type: 'text', text: 'goodbye' }] } } },
  ]
  // 尾部属于 turn 2；向前扫到 turn 2 的 turn/start 即停 → 只含 turn 2，且 user 在前。
  assert.equal(extractTurn(events), '[user] bye\n[assistant] goodbye')
})

test('extractTurn 容忍缺失/残缺事件', () => {
  assert.equal(extractTurn([]), '')
  assert.equal(extractTurn(null), '')
  assert.equal(extractTurn([{ type: 'user/message', data: {} }]), '')
  // 没有 turn/start：整段日志视为一轮。
  assert.equal(
    extractTurn([{ type: 'user/message', data: { content: [{ type: 'text', text: 'solo' }], source: { kind: 'user' } } }]),
    '[user] solo',
  )
})

test('extractTurn 过滤注入脚手架：只收 source.kind==="user" 的 user/message', () => {
  // 真实 headless 会话里，一轮的 user/message 混着 DSH 注入的 AGENTS.md/runtime-context/
  // skills（各自 source.kind 不同）。不过滤会让 digest 被样板塞满并递归放大——本用例守住该回归。
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '真实提问' }], source: { kind: 'user' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'AGENTS.md 样板' }], source: { kind: 'agent-instructions' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'skills 目录' }], source: { kind: 'skill-catalog' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '插件注入' }], source: { kind: 'plugin', plugin: 'x' } } },
    { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '回答' }] } } },
  ]
  assert.equal(extractTurn(events), '[user] 真实提问\n[assistant] 回答')
})

test('userMessage 形状符合 DSH 内联契约且被冻结', () => {
  const m = userMessage('x', 'memory-shortterm')
  assert.equal(m.role, 'user')
  assert.deepEqual(m.content, [{ type: 'text', text: 'x' }])
  assert.deepEqual(m.source, { kind: 'plugin', plugin: 'memory-shortterm' })
  assert.match(m.id, /^[0-9a-f-]{36}$/)
  assert.notEqual(userMessage('x', 'p').id, m.id) // 每条新 id
  assert.throws(() => {
    m.role = 'assistant'
  })
})

test('capEntries 只保留最新 N 块（真实 ISO 条目头）', () => {
  const text =
    '## 2026-09-07T00:01:00.000Z\nA 内容\n\n' +
    '## 2026-09-07T00:02:00.000Z\nB 内容\n\n' +
    '## 2026-09-07T00:03:00.000Z\nC 内容'
  const capped = capEntries(text, 2)
  assert.ok(capped.startsWith('## 2026-09-07T00:01:00.000Z'))
  assert.ok(capped.includes('## 2026-09-07T00:02:00.000Z'))
  assert.ok(!capped.includes('## 2026-09-07T00:03:00.000Z'))
  assert.equal(capEntries(text, 10), text) // 未超限原样返回
})

test('splitCap 拆出保留块与淘汰块（④ 的基础）', () => {
  const text =
    '## 2026-09-07T00:01:00.000Z\nA 内容\n\n' +
    '## 2026-09-07T00:02:00.000Z\nB 内容\n\n' +
    '## 2026-09-07T00:03:00.000Z\nC 内容'
  const { kept, evicted } = splitCap(text, 2)
  assert.ok(kept.startsWith('## 2026-09-07T00:01:00.000Z') && kept.includes('## 2026-09-07T00:02:00.000Z') && !kept.includes('## 2026-09-07T00:03:00.000Z'))
  assert.equal(evicted, '## 2026-09-07T00:03:00.000Z\nC 内容')
  const under = splitCap(text, 10) // 未超限：全保留、无淘汰
  assert.equal(under.kept, text)
  assert.equal(under.evicted, '')
})

// P2-1 回归（2026-09-07）：assistant 正文里的 Markdown 标题行（`## xxx`）不是会话条目头，
// 不得把同一轮次误切成「新条目」。条目头 = `## <ISO 时间戳>`，由 appendEntry 写入。
test('splitEntries 只认 ISO 条目头，正文 Markdown 标题不误切（P2-1）', () => {
  // 一个真实条目：正文含 `## ` 小标题与 `### ` 行，均属同一轮次。
  const oneEntry =
    '## 2026-09-07T00:01:00.000Z\n[user] 讲讲方案\n[assistant] 结论：\n## 背景\n分析如下\n### 细节\n收尾'
  // 单条目 + 任意 Markdown 正文 → 仍是 1 块（正文整块保留）。
  assert.equal(splitEntries(oneEntry).length, 1)
  assert.deepEqual(splitEntries(oneEntry), [oneEntry])

  // 多条目：只按 ISO 头切（正文里虽有 `## ` 也不新增块）。
  const twoEntries =
    '## 2026-09-07T00:01:00.000Z\n正文含\n## 伪标题行\n不切\n\n' +
    '## 2026-09-07T00:02:00.000Z\n第二个真条目'
  const blocks = splitEntries(twoEntries)
  assert.equal(blocks.length, 2)
  assert.ok(blocks[0].startsWith('## 2026-09-07T00:01:00.000Z') && blocks[0].includes('## 伪标题行'))
  assert.ok(blocks[1].startsWith('## 2026-09-07T00:02:00.000Z'))
})

// P2-1 集成回归：正文含 Markdown 小标题的轮次仍按「轮次」裁剪与淘汰（appendEntry 同源切块）。
test('apply: 正文 Markdown 小标题不导致轮次被误拆/误淘汰（P2-1）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-md-'))
  const handlers = {}
  const ctx = { on: (e, fn) => { handlers[e] = fn }, logger: () => ({ warn() {}, info() {}, error() {} }) }
  apply(ctx, { dir, maxEntries: 1 }) // 只留 1 块：第 2 轮触发淘汰

  // 第 1 轮正文含 `## 小标题`（Markdown 结构）——整轮是一个条目，不应被拆成多个块。
  const mkTurn = (t) => ({
    id: 'sess-MD',
    session: {
      snapshotEvents: () => [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { content: [{ type: 'text', text: t }], source: { kind: 'user' } } },
        { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '回复：\n## 小节A\n内容甲\n## 小节B\n内容乙' }] } } },
      ],
    },
    inject() {},
  })
  completed(handlers)({ agent: mkTurn('第一轮提问') })
  completed(handlers)({ agent: mkTurn('第二轮提问') })

  const shortterm = path.join(dir, 'memory', 'shortterm')
  const sess = fs.readFileSync(path.join(shortterm, 'sess-MD.md'), 'utf8')
  // 只留最新 1 个条目：第二轮整体在、第一轮整体被淘汰（而不是把正文小标题当条目边界拆散）。
  assert.ok(sess.includes('第二轮提问'), '会话文件应留最新轮')
  assert.ok(!sess.includes('第一轮提问'), '会话文件应已淘汰第一轮（整轮，而非被拆散）')
  const cand = fs.readFileSync(path.join(shortterm, 'compile_candidates.md'), 'utf8')
  assert.ok(cand.includes('第一轮提问'), '被淘汰的第一轮应整轮进入候选池')
  // 候选池按条目头分块：每块以 ISO 头开头，正文小标题不成为独立块。
  const candBlocks = cand.trim().split(/\n(?=## \d{4}-\d{2}-\d{2}T)/)
  assert.equal(candBlocks.length, 1, '候选池里被淘汰的只应有 1 个整轮条目（不是被小标题拆散的若干块）')
})

// P1-1 回归（2026-09-07）：compile_candidates.md 与会话摘要同目录但非会话文件，
// buildDigest 召回必须排除它 —— 否则候选池（mtime 最新）会挤占注入预算、把最旧轮次当「最近脉络」。
test('buildDigest 排除 compile_candidates.md 候选池（P1-1 防污染）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-bd-'))
  const root = path.join(dir, 'memory', 'shortterm')
  fs.mkdirSync(root, { recursive: true })
  // 一个真实会话文件（较早 mtime）+ 候选池（mtime 最新 —— 修复前会排最前被召回）。
  const sess = path.join(root, 'sess-LIVE.md')
  fs.writeFileSync(sess, '## 2026-09-07T00:01:00.000Z\n[user] 最近脉络内容\n')
  const cand = path.join(root, CANDIDATES_FILE)
  fs.writeFileSync(cand, '## 2026-09-06T00:01:00.000Z\n[user] 最旧淘汰轮次内容\n')
  const old = Date.now() - 60_000
  fs.utimesSync(sess, new Date(old), new Date(old)) // 会话文件更旧，候选池更新

  const digest = buildDigest(root, 20, 2048)
  assert.ok(digest.includes('最近脉络内容'), '召回应含真实会话文件内容')
  assert.ok(!digest.includes('最旧淘汰轮次内容'), '召回必须排除候选池内容（P1-1）')
})

// 集成：用假 ctx / 假 agent 跑通 apply 的接线，证明核心价值 ——
// 「A 会话的一轮被捕获落盘 → 新会话 B（不同 id）启动时把它召回注入」。
// 全程不碰真实 DSH，只在临时目录做真实文件 IO。
test('apply: turn/end 捕获落盘，session-start 跨会话召回注入', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-'))
  const handlers = {}
  const injected = []
  const ctx = {
    on: (event, fn) => {
      handlers[event] = fn
    },
    logger: () => ({ warn() {}, info() {}, error() {} }),
  }
  apply(ctx, { dir })

  assert.equal(typeof handlers['agent/session-start'], 'function', '应注册 session-start 监听')
  assert.equal(typeof handlers['session/event'], 'function', '应注册 session/event 监听')

  // 会话 A 跑完一轮。
  const agentA = {
    id: 'sess-A',
    // 真实 Session 用 snapshotEvents() 暴露事件、无 .events 属性；mock 必须与真实 API
    // 一致，否则测试会掩盖「访问器写错」这类回归（本 bug 曾因此漏网）。
    session: {
      snapshotEvents: () => [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { content: [{ type: 'text', text: '测试颜色是紫罗兰' }], source: { kind: 'user' } } },
        { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '好的，记住了' }] } } },
      ],
    },
    inject: (m) => injected.push(m),
  }
  completed(handlers)({ agent: agentA })

  const file = path.join(dir, 'memory', 'shortterm', 'sess-A.md')
  assert.ok(fs.existsSync(file), '会话 A 的摘要文件应被写出')
  const body = fs.readFileSync(file, 'utf8')
  assert.ok(body.includes('测试颜色是紫罗兰'), '应含用户文本')
  assert.ok(body.includes('好的，记住了'), '应含助手文本')

  // 新会话 B（不同 id）启动 → 应把 A 的摘要作为背景注入首轮。
  const agentB = { id: 'sess-B', session: { snapshotEvents: () => [] }, inject: (m) => injected.push(m) }
  handlers['agent/session-start']({ agent: agentB })

  assert.equal(injected.length, 1, 'B 启动应恰好注入一条')
  assert.equal(injected[0].role, 'user')
  assert.equal(injected[0].source.plugin, 'memory-shortterm')
  assert.ok(injected[0].content[0].text.includes('测试颜色是紫罗兰'), '跨会话召回应含 A 的内容')
})

// P1-1 ④：会话文件超过 maxEntries 时，被挤出的更旧轮次应转入 compile_candidates.md，而非丢弃。
test('apply: 滚动淘汰的旧轮次路由到 compile_candidates.md（P1-1 ④）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-cand-'))
  const handlers = {}
  const ctx = { on: (e, fn) => { handlers[e] = fn }, logger: () => ({ warn() {}, info() {}, error() {} }) }
  apply(ctx, { dir, maxEntries: 1 }) // 每会话只留 1 块 → 第 2 轮就淘汰第 1 轮

  const mkTurn = (t) => ({
    id: 'sess-C',
    session: {
      snapshotEvents: () => [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { content: [{ type: 'text', text: t }], source: { kind: 'user' } } },
      ],
    },
    inject() {},
  })
  completed(handlers)({ agent: mkTurn('第一轮内容') })
  completed(handlers)({ agent: mkTurn('第二轮内容') })

  const shortterm = path.join(dir, 'memory', 'shortterm')
  const sess = fs.readFileSync(path.join(shortterm, 'sess-C.md'), 'utf8')
  assert.ok(sess.includes('第二轮内容'), '会话文件应留最新轮')
  assert.ok(!sess.includes('第一轮内容'), '会话文件应已淘汰第一轮')

  const candFile = path.join(shortterm, 'compile_candidates.md')
  assert.ok(fs.existsSync(candFile), '候选池文件应被创建')
  const cand = fs.readFileSync(candFile, 'utf8')
  assert.ok(cand.includes('第一轮内容'), '淘汰的第一轮应进候选池')
  assert.ok(/## \d{4}-\d{2}-\d{2}T/.test(cand), '候选块应保留 ## <ISO 时间> 头（clean_candidates.py 按此分块）')
})

// P1-3：memoryPresent 纯谓词 —— L1 块在 surface/inbox/本步已认领任一处即视为仍在；
// compaction 遮蔽后三处皆无 → false（触发重注入）。
test('memoryPresent 命中三处来源，遮蔽后三处皆无则 false', () => {
  const mem = userMessage('有效记忆', 'memory-shortterm')
  const other = { source: { kind: 'user' } }
  const summary = { source: { kind: 'compaction' } }
  const agentWith = (nodes, bySeq, inbox) => ({
    inbox: { nextStep: inbox || [] },
    session: { surface: { nodes }, eventAt: (s) => bySeq[s] },
  })
  // surface 已落
  assert.equal(memoryPresent(agentWith([1], { 1: { type: 'user/message', data: mem } }), []), true)
  // inbox 待认领（防首轮重复注入）
  assert.equal(memoryPresent(agentWith([], {}, [mem]), []), true)
  // 本步已认领 messages
  assert.equal(memoryPresent(agentWith([], {}), [mem]), true)
  // compaction 遮蔽：surface 只剩摘要节点 + 本步是其他消息 → false
  assert.equal(memoryPresent(agentWith([1], { 1: { type: 'user/message', data: summary } }), [other]), false)
  // 空 surface / 空 agent 边界
  assert.equal(memoryPresent(agentWith([], {}), []), false)
})

// P1-3 集成：compaction 把 L1 块移出 surface 后，pre-step 应重建并重注入脉络。
test('apply: pre-step 在 L1 块被遮蔽后重注入（P1-3 compaction 恢复）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-recover-'))
  const handlers = {}
  const ctx = { on: (e, fn) => { handlers[e] = fn }, logger: () => ({ warn() {}, info() {}, error() {} }) }
  apply(ctx, { dir })
  assert.equal(typeof handlers['agent/pre-step'], 'function', '应注册 pre-step 监听')

  // 先让会话 A 落一轮历史 → digest 非空。
  completed(handlers)({ agent: {
    id: 'sess-A',
    session: { snapshotEvents: () => [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: '暗号是紫罗兰' }], source: { kind: 'user' } } },
    ] },
    inject() {},
  } })

  const reinjected = []
  // 模拟 compaction 后：surface 只剩摘要节点，L1 块（plugin/memory-shortterm）已被遮蔽。
  const compactedAgent = {
    inbox: { nextStep: [] },
    session: {
      surface: { nodes: [1, 2] },
      eventAt: (seq) => seq === 1
        ? { type: 'user/message', data: { content: [{ type: 'text', text: '[summary]' }], source: { kind: 'compaction' } } }
        : { type: 'assistant/message', data: {} },
    },
    inject: (m) => reinjected.push(m),
  }
  const decision = await handlers['agent/pre-step'](
    { agent: compactedAgent, messages: [] },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(decision.messages.length, 1, '当前决定应携带恢复记忆')
  assert.equal(reinjected.length, 0, '恢复不得排队到下一步')
  assert.equal(decision.messages[0].source.plugin, 'memory-shortterm')
  assert.ok(decision.messages[0].content[0].text.includes('暗号是紫罗兰'))
})

// P1-3 幂等：L1 块仍可见（未 compaction）时，pre-step 不得重复注入。
test('apply: pre-step 在 L1 块仍可见时不重复注入（P1-3 幂等）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-idem-'))
  const handlers = {}
  const ctx = { on: (e, fn) => { handlers[e] = fn }, logger: () => ({ warn() {}, info() {}, error() {} }) }
  apply(ctx, { dir })
  completed(handlers)({ agent: { id: 'sess-A', session: { snapshotEvents: () => [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '历史内容' }], source: { kind: 'user' } } },
  ] }, inject() {} } })

  const reinjected = []
  const healthyAgent = {
    inbox: { nextStep: [] },
    session: {
      surface: { nodes: [1] },
      eventAt: () => ({ type: 'user/message', data: { content: [{ type: 'text', text: '脉络' }], source: { kind: 'plugin', plugin: 'memory-shortterm' } } }),
    },
    inject: (m) => reinjected.push(m),
  }
  await handlers['agent/pre-step']({ agent: healthyAgent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(reinjected.length, 0, 'L1 块仍可见时不应重注入')
})

// P1-3：reject 步不跑模型 → 不注入（也验证 reject 决策被透传）。
test('apply: pre-step 对 reject 决策不注入（P1-3）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-reject-'))
  const handlers = {}
  const ctx = { on: (e, fn) => { handlers[e] = fn }, logger: () => ({ warn() {}, info() {}, error() {} }) }
  apply(ctx, { dir })
  const reinjected = []
  const agent = { inbox: { nextStep: [] }, session: { surface: { nodes: [] }, eventAt: () => undefined }, inject: (m) => reinjected.push(m) }
  const decision = await handlers['agent/pre-step']({ agent, messages: [] }, async () => ({ kind: 'reject' }))
  assert.deepEqual(decision, { kind: 'reject' })
  assert.equal(reinjected.length, 0, 'reject 步不应注入')
})
