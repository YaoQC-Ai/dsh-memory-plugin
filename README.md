# dsh-memory-plugin

> v0.1.1：已在 DSH **0.1.5-rc.2**、Node.js 24 验证；不等于已验证所有 DSH 版本。

Cross-session **short-term memory** (L1) for [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). Zero dependencies, zero build step — plain Node built-ins and an inlined `UserMessage`.

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

- **Capture** — captures `session/event → turn/end` only when `reason.kind === 'completed'`, once per live session turn.
- **Recall** — on `agent/session-start`, checks existing surface and pending memory before injecting recent digests.
- **Recover** — restores the accepted current-step messages after compaction, or the rebuilt request during a same-step overflow retry.

Capture is rule-based text extraction: no extra LLM calls. Local file I/O is synchronous; failures are logged. It is not a semantic summarization pipeline.

### How it works

Four business listeners plus disposal cleanup; no services injected:

| Event | Action |
|---|---|
| `agent/session-start` | Deduplicate surface/pending memory, then enqueue recall |
| `session/event` | Capture the committed completed turn, bounded by its event sequence |
| `agent/pre-step` | After `next()`, update `decision.messages`, preserve extra fields, settle own pending messages |
| `agent/request-error` | Outer `prepend` listener: await compaction recovery, append recall only for an uncancelled overflow retry with a newer surface generation |

Empty first steps and rejected steps stay unchanged. Retry recovery does not authorize retries, change the compactor's checkpoint/counts, or add an extra step. Capture deduplication is in-process only; aborted/error/empty turns and historical seed events are not captured. A committed event is not a disk-flush guarantee.

Session-event shapes are asymmetric (verified against `packages/core/session/src/types.ts`):

```
user/message      → data IS the UserMessage        (use data.content, ONLY when data.source.kind === 'user')
assistant/message → data is {turn, step, message}   (use data.message.content)
turn/start        → data is {turn}                  (the backward-scan boundary)
```

DSH also injects scaffolding — the workspace `AGENTS.md`, runtime-context snapshots, the skills catalog — as `user/message` events, each stamped with its own `source.kind`. Only a genuine user prompt carries `source.kind === 'user'` (the headless bundle and `session-controller` both stamp it so, and DSH's own tests discriminate injected context by `source.kind !== 'user'`). `extractTurn` therefore **whitelists** `kind === 'user'` rather than blacklisting known plugin kinds — the source map is merge-extensible, so a blacklist would leak every newly added injection kind. Without the filter the digest fills with boilerplate that is then re-injected as "background" and amplified each session.

`session.append` only checks JSON round-trip safety, not a strict per-field schema — so an inlined frozen literal with a fresh `randomUUID()` injects exactly like `llm.createUserMessage()`, with no import of DSH internals.

### Install

> The package `name` is `dsh-memory-plugin`, so `dsh plugin add github:YaoQC-Ai/dsh-memory-plugin`
> resolves the three plugin rows that reference `dsh-memory-plugin[/save|/timer]`.

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

Per-session files reduce write collisions, but the shared candidate archive has no cross-process lock. Digests are not the source of truth; retain the host session logs for recovery.

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
npm test
# Optional: DSH_SOURCE must point to a built 0.1.5-rc.2 source tree.
npm run test:host
```

The 38 unit tests require no host dependencies. The optional integration harness uses real host drivers with a simulated provider, temporary storage and no network. Tests are included in Git, not in the npm runtime package.

### License

MIT

---

## 中文

### 它做什么

让 agent 在新会话开始时「记得」最近若干会话聊过什么。

- **捕获** —— `session/event → turn/end` 且 `reason.kind === 'completed'` 时，按轮次提取 user + assistant 文本，写入会话摘要。
- **召回** —— `agent/session-start` 检查 surface 与 pending 中是否已有记忆，再注入近期摘要。
- **恢复** —— 压缩后修正当前步最终消息；溢出压缩后，在同一步重试重建请求前恢复记忆。

捕获是规则化文本提取，不增加模型调用；本地文件 I/O 是同步的，失败记告警。它不是语义摘要流水线。

### 工作原理

四个业务监听器及一个卸载清理监听器，不注入服务：

| 事件 | 动作 |
|---|---|
| `agent/session-start` | 检查已有记忆，必要时排队召回 |
| `session/event` | 只捕获已提交的 completed 轮次，用 event.seq 限定快照上界 |
| `agent/pre-step` | `await next()` 后修正 `decision.messages`，保留扩展字段，清理本插件 pending |
| `agent/request-error` | `prepend` 外层等待压缩器恢复；仅在溢出 retry、未取消且 surface generation 增加时追加记忆日志 |

空首步、reject 不恢复；后续工具续步不受空首步规则影响。retry 恢复不自行授权重试，不改压缩器计数或 checkpoint，不产生额外 step。去重仅限进程内；取消、错误、空轮次和历史 seed 不捕获。事件提交不代表已经 flush 到磁盘，进程崩溃后的漏捕获不自动补偿。

会话事件形状不对称（已对照 `packages/core/session/src/types.ts` 核对）：

```
user/message      → data 本身就是 UserMessage     （取 data.content，且仅当 data.source.kind === 'user'）
assistant/message → data 是 {turn, step, message}  （取 data.message.content）
turn/start        → data 是 {turn}                 （反向扫描的边界）
```

DSH 还会把工作区 `AGENTS.md`、runtime-context 快照、skills 目录这些脚手架也作为 `user/message` 事件注入，各自带着不同的 `source.kind`。唯有真实用户 prompt 才是 `source.kind === 'user'`（headless bundle 与 `session-controller` 都如此打标，DSH 自身测试也用 `source.kind !== 'user'` 区分注入上下文）。因此 `extractTurn` 采用**白名单** `kind === 'user'`，而非黑名单已知插件 kind——source map 可被插件扩展，黑名单会漏掉每一种新增的注入 kind。不加这道过滤，digest 会被样板塞满，再作为「背景」注入下一会话，逐次放大。

`session.append` 只校验 JSON 无损可序列化，不做逐字段严格 schema 校验 —— 所以内联一个带新 `randomUUID()` 的冻结字面量，注入效果与 `llm.createUserMessage()` 完全一致，且无需 import 任何 DSH 内部模块。

### 安装

> 包 `name` 是 `dsh-memory-plugin`，所以 `dsh plugin add github:YaoQC-Ai/dsh-memory-plugin`
> 能解析引用 `dsh-memory-plugin[/save|/timer]` 的三行插件。

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

按会话分文件可减少写入冲突，但共享候选池没有跨进程锁。摘要不是事实源，恢复依据仍是宿主保留的完整会话日志。

### 同包兄弟插件

- **`memory_save`（save.js）** —— 一个模型工具：把自足的概念页写入 `<dir>/memory/knowledge/`（并维护 `<dir>/memory/knowledge/_index.md`）。入参 `title`（概念名）、`content`（自足正文）、`domain`（三选一：`persona` 用户/人格 · `execution` 工作方式 · `knowledge` 其它），写入前校验取值必须属于这三者。这是 L2 的写半边；读/检索半边（`memory_search`）尚未实现。
- **`memory-timer`（timer.js）** —— 定时维护任务：每个自然日本地时钟 `02:00`（patch 行 `hour`/`minute` 可改）触发一次，默认**只 dry-run**：向 `<dir>/memory/_log.md` 追加触发凭证、状态记入 `<dir>/memory/timer-state.json`，便于先观察节奏再接真实任务；连续失败次数按 `failAlertThreshold` 跟踪告警。它从 base bundle 的 `cordis-plugin-timer` 注入 `timer`（`ctx.interval`）。

### 保存与定时配置（v0.1.1）

- `memory-save.config.wikiDir`：可选绝对路径，优先于 `dir`；未设时仍写 `<dir>/memory/knowledge/`。升级有本机定制路径的安装前，必须显式配置旧落点。
- 标题含非法字符、Windows 设备名、内部保留页名、尾随点/空格或超过 80 字符时直接拒绝；不靠删除字符或截断来改名。概念页与索引不提供跨文件事务。
- `memory-timer.config.enabled: false`：完全禁用启动补跑和轮询。只允许一个进程启用 timer，建议 Web 启用，headless 禁用。
- 同目录临时文件替换可降低状态截断风险，但不是跨进程互斥，也不是 `_log.md` 与状态文件的事务。
- 整机休眠后，下一次 Web 启动或轮询只补最近一个边界；连续两晚观察须使用新部署后的真实记录。

profile patch 示例（这是两个 profile 各自的片段，不要合并）：

```yaml
# headless/cordis.patch.yml
- id: memory-timer
  config:
    enabled: false
```

```yaml
# web/cordis.patch.yml
- id: memory-timer
  config:
    enabled: true
```

`wikiDir` 应在两个 profile 中均指向同一个实际绝对路径。patch 会替换整个 config，不是深层合并；保留现有其他配置项。包默认不指定任何用户路径。

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
npm test
```

38 项单测无需宿主依赖。可选真实宿主集成测试使用已构建的 0.1.5-rc.2 源码、真实驱动与压缩器、模拟提供方和临时目录，不访问网络：

```powershell
$env:DSH_SOURCE = '<已构建的宿主源码绝对路径>'
npm run test:host
```

测试代码随 Git 发布，不包含在 npm 运行包中。

### 许可

MIT
