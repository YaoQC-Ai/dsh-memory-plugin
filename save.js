/**
 * dsh-memory-plugin — memory_save 模型工具（P0-5 最小闭环 / L2 概念页写入的前置切片）
 *
 * 暴露一个模型工具 `memory_save`：当用户要求「记住 X」或产出值得跨会话复用的稳定结论时，
 * agent 调用它，把一条事实直接写成一张 K8 合规的概念页
 * （`$DSH_HOME/memory/knowledge/<slug>.md`）并更新 `_index.md`。
 *
 * 这是 L2 的最小便携片：只做「模型已提炼好的事实 → 结构化概念页落盘」。
 * 有意不做（留给 P2-1 的 memory_compile）：LLM 增量编译、查重合并、矛盾标记、双向链接。
 *
 * 零依赖、零构建：纯 Node 内置模块 + 内联 raw ToolDefinition。
 * 关键事实（已在 DSH 源码核对，勿凭记忆改动）：
 *   · `ctx.tools.register(definition)` 注册模型工具（packages/core/tools 的 ToolRuntime）。
 *   · 不用 `defineTool`（那要 import @deepseek-ai/dsh-tools → N2 版本漂移复活）；raw 注册时
 *     `parameters` 直接给 JSON Schema 对象形 `{type:'object',properties,required}`——这正是
 *     defineTool 内部把扁平 spec 经 parameterSchemaSpecToJsonSchema 转换后交给 register 的形状。
 *   · 支持的 JSON Schema 子集（json-schema.ts assertSupportedJsonSchema）：
 *     type/oneOf/properties/required/additionalProperties/items/enum/const + 注解；越界关键字注册即抛。
 *   · raw 注册没有 defineTool 的自动 args 校验，故 execute 内手动 validateArgs（不简化掉校验）。
 *   · `execute(args, exec)`：`exec.agent` 是调用方 Agent，`exec.agent.id` = SessionId（做来源），
 *     `exec.agent.session.seq` = 当前游标（见 tool-subagent-control/list-agents.ts 的 exec.agent 用法）。
 *   · 概念页 Frontmatter 抄 deploy/03-compile/README §概念页 schema（K8）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'memory-save'
export const inject = ['tools']

/** K8 领域标签（必填其一）。 */
const DOMAINS = Object.freeze(['persona', 'execution', 'knowledge'])

export function apply(ctx, config = {}) {
  const home = config.dir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  if (config.wikiDir !== undefined && (typeof config.wikiDir !== 'string' || !path.isAbsolute(config.wikiDir))) {
    throw new Error('wikiDir 必须是绝对路径')
  }
  const knowledgeRoot = config.wikiDir || path.join(home, 'memory', 'knowledge')

  ctx.tools.register({
    name: 'memory_save',
    description:
      '把一条值得长期记住的事实保存为一张结构化概念页（写入本地记忆库 knowledge/，跨会话可复用）。'
      + '当用户明确要求「记住 X」「以后都 X」，或产出了稳定、值得日后引用的结论时调用。'
      + 'title 用简洁的概念名；content 是要记住的事实正文（自足、可独立理解，不要只写代词）；'
      + 'domain 三选一：persona（用户/人格相关，如称呼、偏好、身份）、execution（工作方式/流程/约定）、knowledge（其它知识）。'
      + '安全：绝不要把密码 / token / 密钥 / 私钥等敏感凭据写入。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '概念名（简洁，用作页面标题与文件名）。' },
        content: { type: 'string', description: '要记住的事实正文，自足、可独立理解。' },
        domain: { type: 'string', enum: [...DOMAINS], description: '领域标签：persona | execution | knowledge。' },
        aliases: { type: 'array', items: { type: 'string' }, description: '可选别名列表。' },
      },
      required: ['title', 'content', 'domain'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          title: { type: 'string' },
          created: { type: 'boolean' },
        },
        required: ['path', 'title', 'created'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已${value.created ? '新建' : '更新'}概念页「${value.title}」→ ${value.path}`,
      }],
    },
    async execute(args, exec) {
      const violations = validateArgs(args)
      if (violations.length) throw new Error(`memory_save 参数无效: ${violations.join('; ')}`)
      const agent = exec && exec.agent
      const sessionId = agent && agent.id !== undefined ? String(agent.id) : undefined
      const seq = agent && agent.session && typeof agent.session.seq === 'number' ? agent.session.seq : undefined
      const result = saveConceptPage(knowledgeRoot, args, { sessionId, seq })
      ctx.logger(name).info('saved concept page %s (domain=%s, created=%s)', result.path, args.domain, result.created)
      return result
    },
  })
}

// ---------------------------------------------------------------------------
// 纯函数（导出以便零依赖自检；见 save.test.js）
// ---------------------------------------------------------------------------

/** 手动校验 args（raw 注册无 defineTool 自动校验）；返回违规列表，空=通过。 */
export function validateArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ['args 不是对象']
  const v = []
  try { slugify(args.title) } catch (err) { v.push(err.message) }
  if (typeof args.content !== 'string' || !args.content.trim()) v.push('content 必须是非空字符串')
  if (!DOMAINS.includes(args.domain)) v.push(`domain 必须是 ${DOMAINS.join(' | ')} 之一`)
  if (args.aliases !== undefined && (!Array.isArray(args.aliases) || args.aliases.some((a) => typeof a !== 'string'))) {
    v.push('aliases 必须是字符串数组')
  }
  return v
}

/** 标题必须原样可安全用作文件名和 Wiki 链接；拒绝静默删字/截断造成覆盖。 */
export function slugify(title) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('title 必须是非空字符串')
  const s = title.trim()
  if (s.length > 80 || /[\\/:*?"<>|#\[\]^`\x00-\x1f\x7f]/.test(title) || /[. ]$/.test(title)
    || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(s)
    || /^_(index|log)(?:\.|$)/i.test(s) || /^compile_candidates(?:\.|$)/i.test(s)) {
    throw new Error('title 含非法字符、过长、尾随点/空格或保留文件名')
  }
  return s
}

/**
 * YAML 标量：含破坏性字符则双引号包裹并转义，防 Frontmatter 被标题里的 `:` 等打散。
 * 最小实现，只处理概念页用到的字符串字段。
 */
export function yamlStr(value) {
  const s = String(value)
  if (/[:#\[\]{}&*!|>'"%@`,\\\x00-\x1f\x7f]|^\s|\s$/.test(s)
    || /^(?:null|true|false|yes|no|on|off|~|[-+]?\d.*)$/i.test(s)) return JSON.stringify(s)
  return s
}

/** 构造 K8 合规概念页（Frontmatter + 正文）。created/updated 分开传（更新时保留原 created）。 */
export function buildConceptPage(args, { sessionId, seq, created, updated }) {
  const title = args.title.trim()
  const aliases = Array.isArray(args.aliases) && args.aliases.length ? args.aliases : [title]
  const source = sessionId ? `session/${sessionId}${seq !== undefined ? ` seq ${seq}` : ''}` : '-'
  const fm = [
    '---',
    `title: ${yamlStr(title)}`,
    `aliases: [${aliases.map(yamlStr).join(', ')}]`,
    'kind: memory-concept',
    `source: [${yamlStr(source)}]`,
    `created: ${created}`,
    `updated: ${updated}`,
    `tags: [${args.domain}]`,
    'links: []',
    'status: draft',
    '---',
  ].join('\n')
  return `${fm}\n\n# ${title}\n\n## 核心内容\n\n${args.content.trim()}\n\n## 来源与依据\n\n${source}\n\n## 相关页面\n\n-\n`
}

/** 写概念页（已存在则保留原 created、刷新 updated）+ 更新 _index.md；返回 {path,title,created}。 */
export function saveConceptPage(knowledgeRoot, args, { sessionId, seq }) {
  const violations = validateArgs(args)
  if (violations.length) throw new Error(`memory_save 参数无效: ${violations.join('; ')}`)
  const today = new Date().toISOString().slice(0, 10)
  const slug = slugify(args.title)
  const filePath = path.join(knowledgeRoot, `${slug}.md`)
  let created = today
  let isNew = true
  try {
    const old = fs.readFileSync(filePath, 'utf8')
    isNew = false
    const m = old.match(/^created:\s*(.+)$/m)
    if (m) created = m[1].trim()
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  fs.mkdirSync(knowledgeRoot, { recursive: true })
  fs.writeFileSync(filePath, buildConceptPage(args, { sessionId, seq, created, updated: today }))
  updateIndex(knowledgeRoot, slug, args.domain, today)
  return { path: filePath, title: args.title.trim(), created: isNew }
}

/** 更新 _index.md 表格：移除本 slug 旧行、追加新行（最小去重；真索引/链接留 P2）。 */
export function updateIndex(knowledgeRoot, slug, domain, today) {
  const indexPath = path.join(knowledgeRoot, '_index.md')
  const HEADER = ['# Memory Wiki 概念页索引', '', '| 概念 | 域 | 状态 | 更新时间 |', '|---|---|---|---|']
  let lines
  try {
    lines = fs.readFileSync(indexPath, 'utf8').split('\n')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    lines = [...HEADER]
  }
  const sepIdx = lines.findIndex((l) => l.trim().startsWith('|---'))
  const head = sepIdx >= 0 ? lines.slice(0, sepIdx + 1) : [...HEADER]
  const rows = (sepIdx >= 0 ? lines.slice(sepIdx + 1) : []).filter((l) => l.trim() && !l.toLowerCase().includes(`[[${slug.toLowerCase()}]]`))
  rows.push(`| [[${slug}]] | ${domain} | draft | ${today} |`)
  fs.writeFileSync(indexPath, [...head, ...rows].join('\n') + '\n')
}
