/** 可选宿主集成：DSH_SOURCE 指向已构建的 0.1.5-rc.2 源码树，零网络、隔离目录。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as memory from './index.js'
import * as save from './save.js'
import * as timer from './timer.js'

const host = process.env.DSH_SOURCE
assert.ok(host, '请设置 DSH_SOURCE（已构建宿主源码目录）')
assert.equal(JSON.parse(fs.readFileSync(path.join(host, 'package.json'))).version, '0.1.5-rc.2')
const load = (relative) => import(pathToFileURL(path.join(host, relative, 'lib/index.js')).href)
const { Context } = await load('vendor/cordis')
const { mountAgentLoopTestDependencies } = await load('packages/test-support/agent-loop-testkit')
const { default: AgentLoop } = await load('packages/core/agent-loop')
const { default: TokenMeter } = await load('packages/llm/token-meter')
const { BasicCompactionEngine } = await load('packages/compaction/compaction-basic')
const { Session, SessionId } = await load('packages/core/session')
const { LlmAdapter, LlmError, createUserMessage, createMessage } = await load('packages/llm/llm')
const { default: Timer } = await load('vendor/timer')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-compat-'))
process.env.DSH_HOME = dir
const root = path.join(dir, 'memory/shortterm')
fs.mkdirSync(root, { recursive: true })
fs.writeFileSync(path.join(root, 'history.md'), '唯一集成召回标记')
const user = (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const hasMemory = (request) => request.messages.some((m) => m.source?.plugin === memory.name)
const report = []

class Adapter extends LlmAdapter {
  requests = []
  summaries = 0
  overflow = false
  contextWindow = 1024
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: this.contextWindow } }
  }
  async * stream(options) {
    const summary = JSON.stringify(options.messages.at(-1)).includes('acting as a compaction engine')
    if (summary) this.summaries++
    else {
      this.requests.push(options)
      if (this.overflow) {
        this.overflow = false
        throw new LlmError('测试上下文溢出', 'CONTEXT_WINDOW_EXCEEDED')
      }
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: summary ? 'CHECKPOINT' : '完整测试答复' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function seed() {
  const s = Session.create(SessionId('seed'))
  for (let turn = 1; turn <= 2; turn++) {
    s.append('turn/start', { turn })
    s.append('step/start', { turn, step: 1 })
    if (turn === 1) s.append('user/message', memory.userMessage('旧背景', memory.name), { surfaceOp: 'append' })
    s.append('user/message', user('old history '.repeat(400)), { surfaceOp: 'append' })
    s.append('assistant/message', { turn, step: 1, stream: [], message: createMessage({
      role: 'assistant', content: [{ type: 'text', text: 'old answer '.repeat(200) }], source: { kind: 'model', provider: 'mock', model: 'mock' },
    }) }, { surfaceOp: 'append' })
    s.append('step/end', { turn, step: 1 })
    s.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return s.snapshotEvents()
}

async function harness(auto) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '', personaSuffix: '' } })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(Timer)
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const compactFiber = ctx.plugin(BasicCompactionEngine, { auto, thresholdRatio: 0.8, retainTokens: 50, maxTokens: 64, compactionRetries: 0, maxOverflowRetries: 1 })
  await compactFiber
  const memFiber = ctx.plugin(memory, { dir })
  await memFiber
  const compact = ctx.get('compaction')
  return { ctx, adapter, compact, memFiber }
}

async function send(agent, text) {
  agent.followup(user(text))
  await agent.whenIdle()
  const end = agent.session.snapshotEvents().findLast((ev) => ev.type === 'turn/end')
  assert.equal(end?.data.reason.kind, 'completed', JSON.stringify(end?.data.reason))
}

for (const mode of ['auto', 'manual', 'overflow']) {
  const h = await harness(mode !== 'manual')
  if (mode === 'overflow') h.adapter.contextWindow = 1_000_000
  try {
    const { agent } = await h.ctx.agentLoop.createAgent(h.ctx, {
      sessionId: SessionId(mode), seed: seed(), agentOptions: { provider: 'mock', model: 'mock' },
    })
    // 先建立路由 header；auto 可能在这一步的入口缺少历史路由，下一轮才触发。
    await send(agent, '建立路由')
    const before = h.adapter.requests.length
    const steps = agent.session.snapshotEvents().filter((ev) => ev.type === 'step/start').length
    if (mode === 'manual') {
      assert.ok(h.compact, '宿主未提供 compaction 服务')
      assert.ok(await h.compact.compactNow(agent, new AbortController().signal))
    }
    if (mode === 'overflow') h.adapter.overflow = true
    await send(agent, '压缩后请求')
    const requests = h.adapter.requests.slice(before)
    assert.equal(requests.length, mode === 'overflow' ? 2 : 1, mode)
    assert.ok(hasMemory(requests.at(-1)), `${mode} 当前请求缺少记忆`)
    assert.equal(agent.inbox.nextStep.length, 0)
    assert.equal(agent.session.snapshotEvents().filter((ev) => ev.type === 'step/start').length - steps, 1)
    assert.ok(agent.session.snapshotEvents().some((ev) => ev.type === 'compaction/summary'))
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('CHECKPOINT'))
    report.push({ mode, requests: requests.length, steps: 1, memory: true, summaries: h.adapter.summaries })
  } finally { await h.ctx.fiber.dispose() }
}

const h = await harness(false)
try {
  // 延长轮次经过两次 stopping，但只有一个完成摘要；新会话首请求召回。
  let stopping = 0
  const off = h.ctx.on('agent/turn-stopping', ({ agent }) => {
    if (++stopping === 1) agent.steer(user('追加完成工作'))
  })
  const a = await h.ctx.agentLoop.create(SessionId('capture-a'), { provider: 'mock', model: 'mock' })
  await send(a, '跨会话测试事实')
  off()
  assert.equal(stopping, 2)
  assert.equal(memory.splitEntries(fs.readFileSync(path.join(root, 'capture-a.md'), 'utf8')).length, 1)
  const b = await h.ctx.agentLoop.create(SessionId('recall-b'), { provider: 'mock', model: 'mock' })
  await send(b, '确认召回')
  assert.ok(JSON.stringify(h.adapter.requests.at(-1)).includes('跨会话测试事实'))
  // seed/resume 不重放完成事件，也不重复注入。
  const { agent: resumed } = await h.ctx.agentLoop.createAgent(h.ctx, {
    sessionId: SessionId('resumed'), seed: b.session.snapshotEvents(), agentOptions: { provider: 'mock', model: 'mock' },
  })
  assert.equal(resumed.inbox.nextStep.filter((m) => m.source.plugin === memory.name).length, 0)
  await send(resumed, '恢复')
  assert.equal(h.adapter.requests.at(-1).messages.filter((m) => m.source?.plugin === memory.name).length, 1)
  // 真实 effect 卸载再加载；重复工具注册会由宿主抛错。
  await h.memFiber.dispose()
  await h.ctx.plugin(memory, { dir })
  const saveFiber = h.ctx.plugin(save, { dir, wikiDir: path.join(dir, 'wiki') })
  await saveFiber
  await saveFiber.dispose()
  await h.ctx.plugin(save, { dir, wikiDir: path.join(dir, 'wiki') })
  const timerFiber = h.ctx.plugin(timer, { dir, pollMs: 10 })
  await timerFiber
  await timerFiber.dispose()
  await h.ctx.plugin(timer, { dir, pollMs: 10 })
  const after = await h.ctx.agentLoop.create(SessionId('after-reload'), { provider: 'mock', model: 'mock' })
  await send(after, '重载后')
  assert.equal(h.adapter.requests.at(-1).messages.filter((m) => m.source?.plugin === memory.name).length, 1)
  assert.equal(memory.splitEntries(fs.readFileSync(path.join(root, 'after-reload.md'), 'utf8')).length, 1)
  report.push({ capture: 'extended-once', recall: 'first-request', resume: 'dedup', reload: 'ok', memorix: 'absent' })
} finally { await h.ctx.fiber.dispose() }
console.log(JSON.stringify({ host: '0.1.5-rc.2', isolated: true, report }, null, 2))
