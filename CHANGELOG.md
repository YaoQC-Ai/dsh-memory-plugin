# 版本记录

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
