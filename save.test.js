/**
 * 零依赖自检：node --test（save.js 的纯逻辑 + apply 接线）
 *
 * 覆盖 memory_save 的非平凡逻辑 —— validateArgs 的边界、slugify 去非法字符、
 * yamlStr 的引号包裹、buildConceptPage 的 K8 Frontmatter、saveConceptPage 的增量
 * （保留原 created）、updateIndex 的去重；以及 apply 用假 ctx.tools 跑通「注册 → 执行 → 落盘」。
 * 不碰真实 DSH（exec.agent 用假对象）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, validateArgs, slugify, yamlStr, buildConceptPage, saveConceptPage, updateIndex } from './save.js'

test('validateArgs 拒绝残缺/越界，接受合法', () => {
  assert.deepEqual(validateArgs({ title: 'x', content: 'y', domain: 'persona' }), [])
  assert.ok(validateArgs(null).length)
  assert.ok(validateArgs({ title: '', content: 'y', domain: 'persona' }).length) // 空 title
  assert.ok(validateArgs({ title: 'x', content: 'y', domain: 'nope' }).length) // 越界 domain
  assert.ok(validateArgs({ title: 'x', content: 'y', domain: 'persona', aliases: 'not-array' }).length)
  assert.deepEqual(validateArgs({ title: 'x', content: 'y', domain: 'knowledge', aliases: ['a'] }), [])
})

test('slugify 去非法字符、保留中文、兜底 untitled', () => {
  assert.equal(slugify('张三的名字'), '张三的名字')
  assert.equal(slugify('a/b:c*d?'), 'abcd')
  assert.equal(slugify('   '), 'untitled')
})

test('yamlStr 含破坏性字符则双引号包裹并转义', () => {
  assert.equal(yamlStr('简单'), '简单')
  assert.equal(yamlStr('a: b'), '"a: b"')
  assert.equal(yamlStr('has"quote'), '"has\\"quote"')
})

test('buildConceptPage 产出 K8 合规 Frontmatter', () => {
  const page = buildConceptPage(
    { title: '张三的名字', content: '张三叫 XXX。', domain: 'persona', aliases: ['张三'] },
    { sessionId: 'sess-1', seq: 42, created: '2026-09-05', updated: '2026-09-05' },
  )
  assert.ok(page.startsWith('---\n'))
  assert.ok(page.includes('title: 张三的名字'))
  assert.ok(page.includes('kind: memory-concept'))
  assert.ok(page.includes('source: [session/sess-1 seq 42]'))
  assert.ok(page.includes('tags: [persona]'))
  assert.ok(page.includes('status: draft'))
  assert.ok(page.includes('# 张三的名字'))
  assert.ok(page.includes('张三叫 XXX。'))
})

test('saveConceptPage 首写 created=true，二写保留原 created、created=false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-save-'))
  const root = path.join(dir, 'knowledge')
  const r1 = saveConceptPage(root, { title: 'T', content: 'v1', domain: 'knowledge' }, { sessionId: 's1' })
  assert.equal(r1.created, true)
  assert.ok(fs.existsSync(r1.path))
  // 篡改 created 日期，验证二次写入保留它、只刷新 updated 与正文。
  fs.writeFileSync(r1.path, fs.readFileSync(r1.path, 'utf8').replace(/^created:.*$/m, 'created: 2000-01-01'))
  const r2 = saveConceptPage(root, { title: 'T', content: 'v2', domain: 'knowledge' }, { sessionId: 's1' })
  assert.equal(r2.created, false)
  const body = fs.readFileSync(r2.path, 'utf8')
  assert.ok(body.includes('created: 2000-01-01'), '应保留原 created')
  assert.ok(body.includes('v2'), '应刷新正文')
})

test('updateIndex 去重同一 slug、保留表头', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-idx-'))
  updateIndex(dir, 'A', 'persona', '2026-09-05')
  updateIndex(dir, 'A', 'persona', '2026-09-06') // 同 slug 再来一次
  updateIndex(dir, 'B', 'execution', '2026-09-06')
  const idx = fs.readFileSync(path.join(dir, '_index.md'), 'utf8')
  assert.equal((idx.match(/\[\[A\]\]/g) || []).length, 1, 'A 只应有一行')
  assert.ok(idx.includes('[[B]]'))
  assert.ok(idx.includes('|---|'), '表头分隔行应在')
  assert.ok(idx.includes('2026-09-06'), 'A 应更新为最新日期')
})

// 集成：用假 ctx.tools 跑通 apply 的注册 + 一次真实执行（临时目录真实文件 IO）。
test('apply: 注册 memory_save 工具，execute 校验+落盘概念页', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-apply-'))
  let registered
  const ctx = {
    tools: { register: (def) => { registered = def } },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  apply(ctx, { dir })

  assert.equal(registered.name, 'memory_save')
  assert.equal(typeof registered.execute, 'function')
  // raw 注册契约：parameters 是 JSON Schema 对象形（不是 defineTool 的扁平 spec）。
  assert.equal(registered.parameters.type, 'object')
  assert.ok(registered.parameters.properties.title)
  assert.deepEqual(registered.parameters.required, ['title', 'content', 'domain'])
  assert.deepEqual(registered.parameters.properties.domain.enum, ['persona', 'execution', 'knowledge'])

  // 合法调用 → 落盘，来源含 session/seq。
  const exec = { agent: { id: 'sess-apply', session: { seq: 7 } } }
  const res = await registered.execute({ title: '张三的名字', content: '张三叫 XXX。', domain: 'persona' }, exec)
  assert.equal(res.created, true)
  assert.ok(fs.existsSync(res.path))
  assert.ok(fs.readFileSync(res.path, 'utf8').includes('source: [session/sess-apply seq 7]'))

  // output.render 产出 ContentBlock。
  const blocks = registered.output.render({}, res)
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.includes('张三的名字'))

  // 非法调用 → 抛错（手动校验守住 raw 注册缺失的自动校验）。
  await assert.rejects(() => registered.execute({ title: '', content: 'x', domain: 'persona' }, exec))

  // 无 agent 的调用方（exec.agent 缺失）→ 仍可落盘，来源退化为 '-'。
  const res2 = await registered.execute({ title: '无来源事实', content: 'C', domain: 'knowledge' }, {})
  assert.ok(fs.readFileSync(res2.path, 'utf8').includes('source: [-]'))
})
