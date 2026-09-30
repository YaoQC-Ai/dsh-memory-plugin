# 版本记录

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
- 已完成静态与隔离宿主集成验证；**尚未在 live DSH 重启核对**——`dsh --dump-config` 三插件行无 skip/incompat 警告、durable 日志注入 seq 早于 `turn/start`、Web UI 召回行渲染，需部署到安装副本并重启后验证。
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
