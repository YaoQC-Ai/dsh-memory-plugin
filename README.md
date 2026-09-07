# dsh-memory-plugin

> **Give your DeepSeek-Harness a memory that actually sticks.** — 让你的 DSH 真正记住每一次对话，长出一只可用的"长期记忆"。

Every agent *forgets* the moment a session ends. `dsh-memory-plugin` gives
[DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) a real
memory backbone — so the next session picks up right where the last one left off.
No external services, no build step, no schema to maintain. **Zero dependencies.**

What you get, out of the box:

- 🧠 **Remember across sessions** — each turn is captured and the recent ones are
  re-injected as background the moment a new session starts (L1 short-term memory).
- 📚 **Save what matters** — a first-class model tool (`memory_save`) writes durable,
  self-contained knowledge pages that survive long after the chat ends (L2 write half).
- ⏰ **Keep it fresh** — a scheduled maintenance task (`memory-timer`) looks after the
  memory store daily at 02:00, dry-run safe.
- 🔍 **Optional semantic recall** — layer the official [Memorix MCP memory
  server](https://github.com/deepseek-ai/deepseek-harness/tree/master/examples/mcp-memory)
  for true semantic search (L3).

所有 Agent 都会在会话结束那一刻"失忆"。`dsh-memory-plugin` 给 DSH 装上真正的记忆骨架——
下一个会话能顺接着上一个往下聊。无需外部服务、无需构建、无需维护 schema，**零依赖**。

开箱即得：

- 🧠 **跨会话记忆**（L1）—— 每轮自动捕获，新会话自动召回注入；
- 📚 **知识沉淀**（L2 写入）—— `memory_save` 模型工具落盘自足的概念页；
- ⏰ **自动维护**（定时器）—— 每天 02:00 温控记忆仓，dry-run 安全；
- 🔍 **可选语义召回**（L3）—— 叠加官方 Memorix MCP，做真正的语义搜索。

---

One package, three host plugins (each is a `cordis.patch.yml` row; this README focuses on the L1 plugin and summarizes its siblings):

| Plugin row | File | What it does |
|---|---|---|
| `dsh-memory-plugin` | `index.js` | **L1** short-term cross-session memory — capture / recall / evict / recover (this document) |
| `dsh-memory-plugin/save` | `save.js` | `memory_save` model tool — writes a concept page into `<dir>/memory/knowledge/` |
| `dsh-memory-plugin/timer` | `timer.js` | `memory-timer` — scheduled maintenance task (default 02:00 wall-clock, dry-run safe) |

为 [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）提供跨会话**短时记忆**（L1）。零依赖、零构建 —— 纯 Node 内置模块 + 内联构造 `UserMessage`。

一个包、三个宿主插件（每个都是 `cordis.patch.yml` 的一行；本 README 详述 L1 插件，并概述两个兄弟插件）：

| 插件行 | 文件 | 作用 |
|---|---|---|
| `dsh-memory-plugin` | `index.js` | **L1** 跨会话短时记忆 —— 捕获 / 召回 / 淘汰 / 恢复（本文档） |
| `dsh-memory-plugin/save` | `save.js` | `memory_save` 模型工具 —— 把概念页写入 `<dir>/memory/knowledge/` |
| `dsh-memory-plugin/timer` | `timer.js` | `memory-timer` —— 定时维护任务（默认本地时钟 02:00，dry-run 安全） |

---

## English

### What it does

Makes an agent *remember what recent sessions talked about* when a new session starts.

- **Capture** — on `agent/turn-stopping`, distills that turn's user + assistant text into a per-session Markdown digest.
- **Recall** — on `agent/session-start` (any source: `startup | resume | clear | compact`), aggregates the most recent session files and injects them as background context into the first turn.

That is the whole plugin. It is deliberately **not** an LLM pipeline: capture is rule-based text extraction, so it costs nothing and never blocks a turn.

### How it works

Two `ctx.on` listeners, no services injected:

| Event | Payload used | Action |
|---|---|---|
| `agent/session-start` | `{ agent }` | `agent.inject(userMessage(digest))` — synchronous, so it reliably lands in the first turn |
| `agent/turn-stopping` | `{ agent }` | read `agent.session.snapshotEvents()`, extract this turn, prepend to `<id>.md` |

Session-event shapes are asymmetric (verified against `packages/core/session/src/types.ts`):

```
user/message      → data IS the UserMessage        (use data.content, ONLY when data.source.kind === 'user')
assistant/message → data is {turn, step, message}   (use data.message.content)
turn/start        → data is {turn}                  (the backward-scan boundary)
```

DSH also injects scaffolding — the workspace `AGENTS.md`, runtime-context snapshots, the skills catalog — as `user/message` events, each stamped with its own `source.kind`. Only a genuine user prompt carries `source.kind === 'user'` (the headless bundle and `session-controller` both stamp it so, and DSH's own tests discriminate injected context by `source.kind !== 'user'`). `extractTurn` therefore **whitelists** `kind === 'user'` rather than blacklisting known plugin kinds — the source map is merge-extensible, so a blacklist would leak every newly added injection kind. Without the filter the digest fills with boilerplate that is then re-injected as "background" and amplified each session.

`session.append` only checks JSON round-trip safety, not a strict per-field schema — so an inlined frozen literal with a fresh `randomUUID()` injects exactly like `llm.createUserMessage()`, with no import of DSH internals.

### Install

> Published under the GitHub owner `YaoQC-Ai` (the package `name` is
> `dsh-memory-plugin`, so `dsh plugin add github:YaoQC-Ai/dsh-memory-plugin` resolves the three
> plugin rows that reference `dsh-memory-plugin[/save|/timer]`).

From a git host (pnpm links the checkout; nothing is built):

```sh
dsh plugin --profile <name> add github:YaoQC-Ai/dsh-memory-plugin
```

From a local checkout:

```sh
dsh plugin --profile <name> add ./dsh-memory-plugin
```

Verify the layer, then start:

```sh
dsh --profile <name> --dump-config   # shows a "# == dsh-memory-plugin" layer
dsh --profile <name>
```

### Configuration

Every knob is optional; add a `config:` block to the patch row to override.

| Key | Default | Meaning |
|---|---|---|
| `dir` | `$DSH_HOME` or `~/.dsh` | Base dir; digests live under `<dir>/memory/shortterm/` |
| `maxChars` | `2048` | Cap on the injected digest |
| `maxEntries` | `50` | Turns kept per session file |
| `recentFilesCap` | `20` | Session files aggregated on recall (most recent first) |
| `assistantMaxChars` | `280` | Truncation length for a single assistant line in the digest |
| `maxCandidates` | `500` | Evicted-turn candidates kept in `compile_candidates.md` (the L1 aging archive — **excluded from recall** so it cannot pollute the injected digest) |

### Storage

```
<dir>/memory/shortterm/
├── <session-id-1>.md    # newest turn first, capped at maxEntries
├── <session-id-2>.md
└── ...
```

Evicted turns are not dropped: they roll into `<dir>/memory/shortterm/compile_candidates.md` (a shared aging archive, capped at `maxCandidates`). That file lives beside the per-session digests but is **excluded from recall** — `buildDigest` never reads it, so the archive cannot crowd out real recency or be re-injected as "background". Entry boundaries in both files are `## <ISO timestamp>` lines; Markdown headings like `## foo` inside an assistant reply stay part of their turn and are not split into fake entries.

Per-session files avoid concurrent-write races. These are a **fast digest for injection**, not the source of truth — DSH already persists the full session event log, so trimming old entries loses nothing recoverable.

### Sibling plugins in this package

- **`memory_save` (save.js)** — a model tool that writes a self-contained concept page into `<dir>/memory/knowledge/` (maintaining `<dir>/memory/knowledge/_index.md`). It takes `title` (concept name), `content` (self-sufficient body) and `domain`, one of `persona | execution | knowledge`; it validates that the value is one of those three before writing. This is the write half of L2 — the read/retrieval half (`memory_search`) is not implemented yet.
- **`memory-timer` (timer.js)** — a scheduled maintenance task: each wall-clock day at `02:00` (configurable via `hour` / `minute` on the patch row) it fires once and — by default — **dry-runs**: it appends a trigger receipt to `<dir>/memory/_log.md` and records state in `<dir>/memory/timer-state.json`, so you can observe the cadence before wiring it to real work. Consecutive failures are tracked against `failAlertThreshold`. It injects `timer` (`ctx.interval`) from the base bundle's `cordis-plugin-timer`.

### Optional: add L3 semantic recall

L1 gives recency; it does not do semantic search. For that, layer the official [Memorix MCP memory example](https://github.com/deepseek-ai/deepseek-harness/tree/master/examples/mcp-memory) MCP memory server **in your own profile's `cordis.patch.yml`** (do not fork it into this package — it needs an external `memorix` binary, and forcing it would break installs that don't have one):

```yaml
- insert:
    - id: memory-memorix
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memorix
        transport: stdio
        command: memorix
        args: [serve]
        cwd: !!js process.cwd()
```

This exposes `mcp__memorix__*` tools the model can call natively.

### Roadmap (not in this slice)

- **L2 compile** — scheduled LLM compilation of digests into concept pages (topics / decisions / todos). The write half of the wiki (`memory_save`) already ships; the scheduled compiler and `memory_search` retrieval do not.
- **N1** — session full-text search is disabled by default in `dsh`; a `session-query` patch override will accompany the `memory_search` iteration.

### Development

```sh
node --test    # zero-dependency self-check of the pure logic
```

### License

MIT

---

## 中文

### 它做什么

让 agent 在新会话开始时「记得」最近若干会话聊过什么。

- **捕获** —— 每轮结束（`agent/turn-stopping`），把这一轮的 user + assistant 文本蒸馏进「按会话 id 分文件」的 Markdown 摘要。
- **召回** —— 每次会话开始（`agent/session-start`，任何来源：`startup | resume | clear | compact`），聚合最近的会话文件，作为背景注入首轮。

这就是插件的全部。它有意**不是**一条 LLM 流水线：捕获是规则化文本提取，零成本、绝不阻塞对话轮次。

### 工作原理

两个 `ctx.on` 监听器，不注入任何服务：

| 事件 | 用到的 payload | 动作 |
|---|---|---|
| `agent/session-start` | `{ agent }` | `agent.inject(userMessage(digest))` —— 同步，稳进首轮 |
| `agent/turn-stopping` | `{ agent }` | 读 `agent.session.snapshotEvents()`，抽取本轮，prepend 到 `<id>.md` |

会话事件形状不对称（已对照 `packages/core/session/src/types.ts` 核对）：

```
user/message      → data 本身就是 UserMessage     （取 data.content，且仅当 data.source.kind === 'user'）
assistant/message → data 是 {turn, step, message}  （取 data.message.content）
turn/start        → data 是 {turn}                 （反向扫描的边界）
```

DSH 还会把工作区 `AGENTS.md`、runtime-context 快照、skills 目录这些脚手架也作为 `user/message` 事件注入，各自带着不同的 `source.kind`。唯有真实用户 prompt 才是 `source.kind === 'user'`（headless bundle 与 `session-controller` 都如此打标，DSH 自身测试也用 `source.kind !== 'user'` 区分注入上下文）。因此 `extractTurn` 采用**白名单** `kind === 'user'`，而非黑名单已知插件 kind——source map 可被插件扩展，黑名单会漏掉每一种新增的注入 kind。不加这道过滤，digest 会被样板塞满，再作为「背景」注入下一会话，逐次放大。

`session.append` 只校验 JSON 无损可序列化，不做逐字段严格 schema 校验 —— 所以内联一个带新 `randomUUID()` 的冻结字面量，注入效果与 `llm.createUserMessage()` 完全一致，且无需 import 任何 DSH 内部模块。

### 安装

> 发布时把下面的 `you` 换成实际 GitHub owner（包 `name` 是 `dsh-memory-plugin`，
> 所以 `dsh plugin add github:<owner>/dsh-memory-plugin` 能解析引用
> `dsh-memory-plugin[/save|/timer]` 的三行插件）。

从 git 托管安装（pnpm 链接该 checkout，不跑任何构建）：

```sh
dsh plugin --profile <name> add github:YaoQC-Ai/dsh-memory-plugin
```

从本地 checkout 安装：

```sh
dsh plugin --profile <name> add ./dsh-memory-plugin
```

先验证层、再启动：

```sh
dsh --profile <name> --dump-config   # 会显示一层 "# == dsh-memory-plugin"
dsh --profile <name>
```

### 配置

所有旋钮都可选；在 patch 行补 `config:` 块即可覆盖。

| 键 | 缺省 | 含义 |
|---|---|---|
| `dir` | `$DSH_HOME` 或 `~/.dsh` | 基准目录；摘要存放在 `<dir>/memory/shortterm/` |
| `maxChars` | `2048` | 注入摘要的字符上限 |
| `maxEntries` | `50` | 每个会话文件保留的轮次条数 |
| `recentFilesCap` | `20` | 召回时聚合的会话文件数（最近优先） |
| `assistantMaxChars` | `280` | 摘要里单条助手文本的截断长度 |
| `maxCandidates` | `500` | `compile_candidates.md` 候选池保留的淘汰轮次块数（L1 老化留档 —— **召回时排除**，不会污染注入摘要） |

### 存储

```
<dir>/memory/shortterm/
├── <session-id-1>.md    # 最新轮次在最前，上限 maxEntries
├── <session-id-2>.md
└── ...
```

被挤出的轮次不丢弃：滚动进入 `<dir>/memory/shortterm/compile_candidates.md`（全会话共享的老化留档，上限 `maxCandidates`）。它与各会话摘要同目录，但**召回时被排除** —— `buildDigest` 从不读它，所以留档不会挤占「近期性」、也不会被当作「背景」重新注入。两类文件的条目边界都是 `## <ISO 时间戳>` 行；assistant 正文里的 Markdown 标题（如 `## foo`）仍属于本轮，不会被误切成伪条目。

按会话分文件避免并发写竞态。它们是**供注入的快速摘要**，不是事实源 —— DSH 本就持久化完整会话事件日志，所以裁剪旧条目不会丢失任何不可恢复的信息。

### 同包兄弟插件

- **`memory_save`（save.js）** —— 一个模型工具：把自足的概念页写入 `<dir>/memory/knowledge/`（并维护 `<dir>/memory/knowledge/_index.md`）。入参 `title`（概念名）、`content`（自足正文）、`domain`（三选一：`persona` 用户/人格 · `execution` 工作方式 · `knowledge` 其它），写入前校验取值必须属于这三者。这是 L2 的写半边；读/检索半边（`memory_search`）尚未实现。
- **`memory-timer`（timer.js）** —— 定时维护任务：每个自然日本地时钟 `02:00`（patch 行 `hour`/`minute` 可改）触发一次，默认**只 dry-run**：向 `<dir>/memory/_log.md` 追加触发凭证、状态记入 `<dir>/memory/timer-state.json`，便于先观察节奏再接真实任务；连续失败次数按 `failAlertThreshold` 跟踪告警。它从 base bundle 的 `cordis-plugin-timer` 注入 `timer`（`ctx.interval`）。

### 可选：叠加 L3 语义召回

L1 提供的是「近期性」，不做语义检索。要语义召回，请把官方的 [Memorix MCP memory 示例](https://github.com/deepseek-ai/deepseek-harness/tree/master/examples/mcp-memory) MCP memory 服务**叠进你自己 profile 的 `cordis.patch.yml`**（不要 fork 进本包 —— 它需要外部 `memorix` 二进制，强加进来会让没装它的用户安装即坏）：

```yaml
- insert:
    - id: memory-memorix
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memorix
        transport: stdio
        command: memorix
        args: [serve]
        cwd: !!js process.cwd()
```

它会暴露 `mcp__memorix__*` 工具，模型可原生调用。

### 路线图（不在本切片内）

- **L2 编译** —— 定时用 LLM 把摘要编译成概念页（主题 / 决定 / 待办）。概念页的写半边（`memory_save`）已随包落地；定时编译器与 `memory_search` 检索尚未实现。
- **N1** —— `dsh` 的会话全文搜索默认关闭；`session-query` 的 patch 覆盖将随 `memory_search` 迭代一起提供。

### 开发

```sh
node --test    # 对纯逻辑做零依赖自检
```

### 许可

MIT
