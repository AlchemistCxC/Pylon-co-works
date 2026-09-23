# Dev Record — #250 实机验收四项（窗口 ACL / probe 会话通知静音 / 扩展块 CTA 溢出 / 右栏 aria-label）

## 元信息

- issue：#250（bug，四项相互独立）
- 分支：`kumo/prometheus`
- 提交范围：`d360f9b0..<head>`（本文提交段）
- 日期：2026-09-24
- spec：`.agents/spec/250-acceptance-four-fixes.md`（一次性，不入库）

## 目标与范围

修复 2026-09-23 实机走查确认的四项不良行为：①窗口尺寸记忆被 ACL 拒绝；②进入聊天视图产生孤儿 draft 会话且通知被竞态丢弃刷 warn；③扩展块「管理…」按钮溢出裁切；④右栏 aria-label 指向过期会话。

**不做什么**：issue 评论补充的三项轻量观察（作者自述留痕存档）；sheet.title 与活动会话不同步的现象本身；Hermes 侧会话对象生命周期。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/capabilities/default.json` | permissions 增补 `core:window:allow-set-size` | 修改 |
| `src-tauri/src/runtime.rs` | 新增 `ProbeSessionRegistry`（FIFO 有界 + TTL）+ `AgentRuntime.probe_sessions` 字段 + 3 个单测 | 修改 |
| `src-tauri/src/session/create.rs` | `probe_agent_selectors` 拿到 peri_id 后登记注册表 | 修改 |
| `src-tauri/src/dispatcher/mod.rs` | `handle_session_update` 增 `probe_sessions` 参数；unknown 分支先查注册表，命中 → debug 静默丢弃 | 修改 |
| `src/components/sidebar/blocks/mockBlocks.tsx` | 扩展块 meta 组 div/span 加 `min-w-0` | 修改 |
| `src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css` | `.sidebar-block-cta` 补 `white-space:nowrap; flex-shrink:0` | 修改 |
| `src/components/right-panel/ContextPanelHost.tsx` | aside aria-label 改稳定文案「右栏」 | 修改 |

## 方案要点

- **item 2 根因与 issue 假设不同**：draft 会话不是「前端 draft 被目标会话替换」，而是 **#53 空态选择器探测**（`AgentRendererSuiteWorkbench` 挂载 → `probeAgentSelectors`，TTL 5 分钟，与实测「16 分钟 3 个 draft id」吻合）。探测会话**设计上不落会话槽位**，其建会话后 agent 迟到的元数据通知在 dispatcher 查无映射，逐条 warn。issue 的「若新建会话直接使用该 draft」担忧不成立（探测会话从不用于聊天）；「疑似 available_commands_update」方向认可。
- 修复选型：不改变「探测不落槽位」的设计，给 runtime 挂 `ProbeSessionRegistry`（peri_id → 时刻，FIFO 32 条、TTL 60s，只进不出——close 后迟到帧恰是静音对象）。dispatcher unknown 分支命中注册表 → `debug!` 静默，未命中 → 原 warn 语义不变。
- item 3 病灶：`.sidebar-block-row-meta` 的 nowrap 文本使父级 flex 项 `min-width:auto` 收缩失败，挤压转向无 nowrap 的按钮。修法 = meta 组放开收缩（`min-w-0`）+ 按钮自身永不收缩换行。
- item 4：`ctx.activeSession` 仅是 id，为可访问名引入 identityStore 订阅不成比例；aside 归属上下文已由页签与 tablist（「右栏面板」）承载，故取稳定文案。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| ① set_size 过 ACL、持久化、重启恢复 | ✅ 实机数值：`set_size` 调用后窗口 1200×800→1128×864（旧构建同调用被 ACL 拒）；>400ms 防抖后 localStorage `pylon-window-size` = `{"width":1128,"height":864}`；重启后 `outerWidth/Height` = 1128×864（默认 1200×800，构成区分） |
| ② 探测会话不再刷 unknown warn | ✅ 实机：`probe_agent_selectors(agentId=hermes)` 成功建探测会话，Hermes 日志 `Created ACP session 3a33114a-cb65-47b2-81df-930e9ddf5a70 (cwd=.)`（与 issue 报告的 draft 签名一致），其后 `unknown session` 检索 0 条（issue 基线：每次探测 2 条 warn，3/3 复现） |
| ③ CTA 单行入容器、meta 截断 | ✅ 实机数值：240px 容器内 `.sidebar-block-cta` = 48.06×24px 单行（clientRects=1），右缘 228 ≤ 240（旧数值：宽 37.06px、右缘 247.45px 溢出 7.45px、竖排）；meta `min-width:0` 生效、overflow hidden + ellipsis、内容 158px 截至显示 122px |
| ④ 右栏 aria-label 稳定 | ✅ 实机：a11y 树 `complementary "右栏"`，`aside.context-panel` aria-label = `右栏`，tablist = `右栏面板`，不随会话名变化 |
| 单测/门禁 | ✅ Rust `cargo test --lib` 811 passed / 0 failed（含新增 probe_registry × 3）；前端 vitest 全量 4812 passed / 0 failed；`tsc -b` 绿；`cargo fmt --check` 绿；clippy 无新增告警（存量 6 处位置均非本次引入）；CSS 消费审计/运行时边界/插件 manifest 契约脚本绿 |

## 测试处置

- 新增：`probe_registry_reports_registered_ids_only` / `probe_registry_fifo_bound_discards_oldest` / `probe_registry_expires_entries_after_ttl`（`src-tauri/src/runtime.rs`）。
- 修改/删除既有测试：无。

## 证据

- commit：本文提交段（capabilities / dispatcher+runtime+create / 前端三处 / 本记录，均 pathspec）。
- 实机环境：本仓 `bun run build` → `cargo build`（dev profile，02:06 产物）→ `target/debug/pylon.exe`，`PYLON_AGENTS_CONFIG=F:\A-I\Platform\Pylon\agents.yaml`（真实 Hermes profile）；CSSOM 自检确认 `.sidebar-block-cta` 含 `white-space:nowrap; flex-shrink:0`（内嵌 dist 为本轮产物，规避 #238 第③件陷阱）。
- 测试：`cargo test --lib` → `811 passed; 0 failed`；`vitest run` → `4812 passed | 1 skipped | 1 todo`。

## 与 spec 的偏差

- 验收环境增加 `PYLON_AGENTS_CONFIG` 指向部署配置：debug 构建的**内嵌** agents.yaml 带部署占位符（`<HERMES_PROFILE_PATH>` 等），不带真实 profile 无法起 Hermes；spec 未预见，属验收手段而非代码偏差。
- item2 的静默丢弃路径本身（`debug!`）受编译期 INFO 级上限（`init_tracing`）约束不在实机日志显形；验收判据取「同签名探测 + 0 warn」（与 issue 的 100% 复现基线对照），静默分支由单测覆盖注册表语义、由代码路径评审覆盖接线。

## 未解问题

- item 2 的「Hermes 侧遗弃一个会话对象」：Pylon 侧 probe close 为 best-effort 已尽力；若 Hermes 在 close 后仍保留会话对象，属 Hermes 生命周期问题，超出本仓范围。
- issue 评论补充的三项轻量观察（Profiles Esc / Browser 98% / Overview 导航高亮）仍为存档状态，如需处理建议另开 issue。

## 并行交集

- 共享文件：`.agents/L.md`（已按规单独提交声明）。未触碰 #252 file 域与 hermes/pylon-core/pylon-acp。
