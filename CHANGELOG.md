# 版本记录

## 0.2.2 — 2026-10-19

针对上游 **DSH 0.2.1-rc.2** 重新核验并前移宿主锚点；运行代码零改动（`index.js`/`save.js`/`timer.js` MD5 与 0.2.0/0.2.1 一致）。

### 核验（对照 `dsh-v0.2.1-rc.2` 真实源码逐文件 diff，非推断）
- **版本闸门放行**：`packages/boot/app-boot/src/plugin-compatibility.ts` 的 `satisfies()` 用 `semver.satisfies(host, range, { includePrerelease: true })`，且「有 `engines.dsh` 就只看它、忽略 peer」。本包 `engines.dsh: ">=0.2.0-rc.1 <0.3.0-0"` 对 `0.2.1-rc.2`（含 prerelease）判定为真 → boot 不会静默跳过本组合包（此前担心的「`--dump-config` 少三行」风险未发生）。
- **会话格式未换代**：`packages/core/session/src/types.ts` 的 `SESSION_FORMAT_VERSION` 仍为 **4**（无 v4→v5），V4 admission（`session-format-v3-to-v4/src/message-sources.ts`）逐字未变 → 注入行 `{ kind:'plugin:memory-shortterm', form:'recall' }` 仍被接收，历史会话仍读得动。
- **依赖的宿主 API 全部未变**：`agent/created`（`runtime-types.ts` 仅文档链接改动）、`session/event` 形状与派发（`session/index.ts` 仅去掉 `@dshScopeScan` 文档标记）、`append(type,data,{surfaceOp})`（仅内部抽出 `publicationEntry()`/`commit()`，公开签名与行为不变）、`agent/pre-step` waterfall 与 `PreStepDecision`（`agent-loop/src/agent.ts` 把 runtime-context 计算挪进默认回调，签名不变）、`surface.nodes`/`replaceGeneration`（`surface.ts` 仅注释）、`ContextForm 'recall'`（`llm/message.ts` 未变）、`inbox.nextStep`/`remove`（`inbox.ts` 未变）。
- **agent-loop 请求循环新增 `refreshContext`**：仅特判 `source.kind === 'runtime-context'` 的消息做刷新替换；本插件注入的 `plugin:memory-shortterm` 走原 `else` 分支逐字 append，不受影响。
- **实验性插件 Session 记录接口**（rc.1 新增 `appendPluginRecord`/`pluginRecordOf`）：源码注释与 `verify-plugin-record-callers` 门禁明确「仅 `packages/experimental/` 下的生产代码可调用」→ 本插件无法也无需采用（进程内 WeakMap 状态维持现状，YAGNI）。

### 变更
- `host.integration.mjs` 默认期望宿主版本 `0.2.0-rc.2` → `0.2.1-rc.2`（仍可用 `DSH_EXPECTED_VERSION` 覆盖）。
- `package.json` 版本 `0.2.1` → `0.2.2`；`engines.dsh`/`peerDependencies` 范围**不动**（已覆盖 rc.2；收紧到 `>=0.2.0` 留待官方正式版落地当天）。
- README（中英）版本横幅、宿主锚点、`test:host` 说明同步到 0.2.1-rc.2；文档中的当前版本与单测数（38→41）一并修正。

### 验证
- 41/41 单测通过（Node v24，运行件未改）。
- 源码契约层核验如上（`git diff dsh-v0.2.0-rc.2..dsh-v0.2.1-rc.2` 逐文件）；版本闸门用 profile 自带 semver 实测 `includePrerelease` 放行 `0.2.1-rc.2`。
- **实建 rc.2 宿主跑集成全绿**：在隔离 `git worktree``pnpm install --frozen-lockfile` + `build:lib:host` 构建真实 0.2.1-rc.2 宿主树（8 个依赖包 `lib/index.js` 齐、root `version=0.2.1-rc.2`），`DSH_SOURCE` 指向它跑 `host.integration.mjs`：`host=0.2.1-rc.2`、三模式（auto/manual/overflow）压缩恢复注入 `memory:true`（请求数 1/1/2、summaries 1）、跨会话首请求召回、seeded startup 注入一次、卸载重载 `ok`、`memorix:absent`、`EXIT=0`。运行件零改动经真宿主运行时确认（非仅源码 diff）。

### 交付边界
- **未 live 重启 DSH 核对**、**未重新部署已安装副本（部署副本仍为 0.2.1）**：集成验证只在隔离 worktree 构建的 rc.2 宿主树上做，未触碰已安装/运行的宿主，验后已移除 worktree。`engines.dsh` 收紧到 `>=0.2.0` 留待官方正式版落地当天。
- 仍为 dry-run：L2 自动编译与 `memory_search` 属后续阶段，未实现。

## 0.2.1 — 2026-10-17

只补声明与验证，运行代码零改动（`index.js`/`save.js`/`timer.js` MD5 与 0.2.0 一致）。

### 变更
- `host.integration.mjs` 默认期望宿主版本 `0.2.0-rc.1` → `0.2.0-rc.2`（仍可用 `DSH_EXPECTED_VERSION` 覆盖）。
- `package.json` 新增 `engines.dsh: ">=0.2.0-rc.1 <0.3.0-0"` 前瞻声明；`peerDependencies` 维持 `^0.2.0-rc.1`（0.2.0-rc.1 与 0.2.0-rc.2 都验证过，不缩小支持面）。选 `engines.dsh` 的理由：DSH 0.2.1-alpha.4 起兼容性检查优先读该字段、其次才回退 peer 范围。
- README（中英）版本横幅与开发段落的宿主锚点统一到 0.2.0-rc.2，并补上 `engines.dsh` 说明；文档中的"当前版本 0.1.1 / 0.1.5-rc.2"陈旧陈述同步修正。
- 定时载体观察期判绿：跨 8 个连续 02:00 边界、`timer-state.json` 为 `lastResult:"ok"` / `consecutiveFailures:0`。

### 验证
- 41/41 单测通过（Node v24）。
- `DSH_SOURCE` 指向已构建的 **0.2.0-rc.2** 源码树跑 `host.integration.mjs`：三模式压缩恢复注入、跨会话首请求召回、seeded 会话注入、三插件卸载重载全部通过，注入行 source 形状仍为 `{ kind:"plugin:memory-shortterm", form:"recall" }`。
- DSH 0.2.0-rc.2 实机（Web profile）核对：`--dump-config` 三行插件均装载且无 skip/incompat 警告、新建会话后 durable 日志中注入 seq 早于 `turn/start`、Web UI 出现「上下文召回」行、`memory-timer` 每日 dry-run 正常留痕。

### 交付边界
- 0.2.1 未单独对外发布，其变更随 0.2.2 一并上线。
- 仍为 dry-run：L2 自动编译与 `memory_search` 属后续阶段，未实现。

## 0.2.0 — 2026-09-30

适配 DSH **0.2.0-rc.1**（Session 格式 V4）：召回主入口迁到 `agent/created`、注入带 `form:'recall'`、捕获改增量累积并停用已废弃的同步事件回读，新增 `peerDependencies` 版本闸门。保留零运行时依赖、零构建。**支持 ≥0.2.0；不再支持 0.1.x 旧宿主**（不做双版本写入）。

### 变更
- 召回注入的 `source.kind` 用生产者自有的 `'plugin:memory-shortterm'`：0.2 的 V4 admission 拒收已淘汰的 catch-all `'plugin'`（否则整轮失败）；识别逻辑仍认得升级前落盘的旧 `kind:'plugin' + plugin` 行。
- 召回入口从 0.2 已删除的 `agent/session-start` 迁到 `agent/created`，按 `source` 决定行为：仅 `startup`/`clear` 注入召回；`resume`（旧注入已持久化）与 `compact`（交压缩恢复路径）跳过，不再让每步 pre-step 兜底充当主注入路径。
- 注入消息 source 增 `form:'recall'`（ContextForm 跨会话召回语义），Web UI 据此渲染成「上下文召回」行而非用户气泡。
- `package.json` 增 `peerDependencies: { "@deepseek-ai/dsh": "^0.2.0-rc.1" }`：宿主不兼容时在 boot 期跳过本组合包并打 stderr 警告，而非等发消息时才因 V4 admission 整轮失败。
- 删除挂在不存在事件上的 `ctx.on('dispose')` 守卫（Cordis 卸载 fiber 时自动摘除监听器）。
- 捕获停用已 `@deprecated` 的 `snapshotEvents()`/`eventAt()`：改为在 `session/event` 内增量累积本轮 user/assistant 文本（`turn/start` 起缓冲、`turn/end` 且 completed 落盘）；`memoryPresent` 的 surface 探测改用「本会话注入 seq + 公开 `surface.nodes.includes`」的自有状态。
- `recall()` 增 per-session digest 缓存（WeakMap），一会话至多扫盘构建一次。
- `host.integration.mjs`：期望宿主版本改由 `DSH_EXPECTED_VERSION`（默认 `0.2.0-rc.1`）提供；注入检测改用 `MEMORY_SOURCE_KIND`（0.2 注入行已无 `source.plugin` 字段）；给 `BasicCompactionEngine` 补 `headroomTokens:0`（0.2 新增默认 65536，否则小上下文窗口测试永不触发压缩）。

### 验证
- 41/41 单测通过（Node v24.15.0；基线 38 → 41，新增 `agent/created` 按 source 注入/跳过、`turnTextOf`、`form:'recall'` 断言）。
- 以 `DSH_SOURCE` 指向已构建的 0.2.0-rc.1 源码跑 `host.integration.mjs`，在隔离目录跑通并打印 report：auto/manual/overflow 三模式压缩恢复均注入记忆、跨会话首请求召回、seeded 会话注入、三插件卸载重载全部通过。
- 注入行 source 形状为 `{ kind:'plugin:memory-shortterm', form:'recall' }`。

### 交付边界
- 已完成静态与隔离宿主集成验证；**尚未在 live DSH 重启核对**（已于 2026-10-17 在 DSH 0.2.0-rc.2 实机完成，见 0.2.1）——`dsh --dump-config` 三插件行无 skip/incompat 警告、durable 日志注入 seq 早于 `turn/start`、Web UI 召回行渲染，需部署到安装副本并重启后验证。
- seeded/fork 会话（`createAgent({ seed })`，其 source 仍为 `startup`）因不再回扫 surface 内容，可能同时带「父会话注入 + 本次召回」两条 L1 块（有界、非递归放大）；真正的 resume（持久化加载，`source='resume'`）在 `agent/created` 处跳过，不产生该重复。
- 仍为 dry-run，未实现 L2 自动编译或 `memory_search`。

## 0.1.1 — 2026-09-23

适配并验证 DSH **0.1.5-rc.2**（Session 格式 3），保留零运行时依赖、零构建。

### 修复
- 压缩后修改最终 `PreStepDecision.messages`，保留 `startsRequestSeries` 等字段；不向空首步补消息，不留下额外 pending 步骤。
- `agent/request-error` 外层等待压缩器恢复，按 surface generation 确认进展，恢复同一步溢出 retry 的请求记忆；原样保留宿主返回值。
- 捕获改为 `session/event → turn/end` 的 completed 轮次，进程内按 Session/turn 去重；排除取消、错误和空轮次。
- 启动/恢复检查 surface 与 inbox，避免重复召回。
- 回收 `wikiDir` 绝对路径配置，通用默认仍为 `<home>/memory/knowledge`；升级本机定制版须显式保留原路径。
- 拒绝非法标题、Windows 设备名、内部保留页名和尾随点/空格，增加 YAML 标量保护及索引大小写去重；非 ENOENT 读取错误不作为首次创建处理。
- 定时器增加 `enabled: false`；状态改为同目录临时文件替换。部署要求单进程启用。

### 验证
- 38/38 单测通过。
- 真实 DSH AgentLoop / Session / BasicCompactionEngine 隔离验证通过：自动与手动压缩各一次正常请求；溢出两次请求尝试、同一个 step；checkpoint 保留、无 pending 残留。
- 跨会话首请求召回、延长轮次只捕获一次、seed/resume 去重、三插件卸载重载、未装 Memorix 的独立运行通过。
- 已安装副本单测与宿主集成复跑通过；真实 headless profile 装载和临时 Wiki 保存通过。Web 重启后的正常认证 API 确认三个插件均 active、无 failed 条目；真实记忆/Wiki 文件哈希未变。
- 集成测试使用模拟提供方，不代表全部真实模型与 Web Agent preset 组合均已验证。

### 交付边界
- 发布包白名单：`npm pack --dry-run` 仅包含 7 个运行包文件；源码仓库另含测试与文档，不含本机路径、用户名、内网地址或密钥（扫描无命中，但不保证覆盖所有隐私风险）。
- 两晚日历定时观察待验收。仍为 dry-run，未实现 L2 自动编译或 `memory_search`。
- 不承诺跨进程/崩溃恰好一次、跨文件事务或自动补捕获；未迁移记忆库、升级 Memorix 或修改宿主内核。

## 0.1.0 — 历史基线

L1 跨会话记忆、候选池滚动淘汰、`memory_save` 与 `memory-timer` 初始版本。部署副本曾以 `wikiDir` 硬编码路径，0.1.1 将路径能力与机器配置分离。
