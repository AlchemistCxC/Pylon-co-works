# Dev Record — #315 归一化缺口收敛 Epic（peri 扩展通道开闸 + _meta 深消费 + hermes 字典反解 + 双栈映射单源化）

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/315
- 分支：kumo/filesheet-stage0（共享树，#279 合并与 #316/#317 在途并行，见「并行交集」）
- 提交范围：见 PR（本记录随首个提交入库）
- 日期：2026-09-25

## 目标与范围

按 issue #315 P0~P2 实施。**做**：peri 扩展通道开闸（caps 声明 + 内核路由 + 前端语义化）、peri tokenStats `_meta` 深消费、`_meta.skillNames` 接线、hermes 字典 title 反解（agents.yaml + toolResolution 全等臂）、canonical↔workbench wire 语义单源对应表 + parity 测试、C16 覆盖清单重计。**不做**：peri 上游改动、cc/hermes ACP-UP 系上游项、`peri/agent_event_done`→session.completed 映射（终态权威红线）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-core/src/agent_config/types.rs` | `default_initialize_caps` 补 4 个 peri.* 键 | 修改 |
| `src-tauri/pylon-acp/src/error.rs` | 4 个 `NOTIF_PERI_*` 方法常量 | 修改 |
| `src-tauri/pylon-acp/src/client.rs` | `AcpKind::ProviderExtension` + from_method 臂 + `wrap_provider_extension_notification` + 单测 | 修改 |
| `src-tauri/src/dispatcher/mod.rs` | ProviderExtension 就地包络为 session/update 后走标准通路 | 修改 |
| `src/domains/workbench/normalizers/periNormalizer.ts` | 扩展通道语义化入口（AcpEvent 22 变体映射 + malformed/unknown 兜底） | 修改 |
| `src/domains/workbench/normalizers/acpNormalizer.ts` | normalizeUsageUpdate `_meta` 深消费；skillNamesOf；available_commands_update 带 skillNames | 修改 |
| `src/domains/workbench/events/workbenchEventSchema.ts` | SessionEvent 增 `skillNames?` | 修改 |
| `src/domains/events/wireSemanticCorrespondence.ts` | 判别符→语义方向单源对应表 | 新增 |
| `src/domains/events/canonicalNormalizer.ts` | canonicalEventTypeFor 委托单源表；session_info_update 漂移修正 | 修改 |
| `src/domains/tool/toolResolution.ts` | 候选匹配补全等命中臂 | 修改 |
| `agents.example.yaml` | hermes 字典 18 项 aliases 补 title 前缀/全等 | 修改 |
| `src/domains/workbench/coverage/*` | periCoverage 16 项转出 + providerCoverageIndex EXTENSION_CHANNEL_IDS(WIRE-EXTENSION) + 门禁测试同步 | 修改 |
| 测试 | periNormalizer.test.ts 扩展映射 8 例、wireSemanticParity.test.ts、toolResolutionTitleRecovery.test.ts | 新增/修改 |

## 方案要点

1. **包络不绕过 journal**：内核把 peri/* 通知就地包络为 `{sessionId, update:{sessionUpdate:'<method>', …}}`，经既有 `handle_session_update` 通路——durable canonical、replay、dedup、批窗口全部复用；`routing::decide` 对未知变体本就 publish/persist（R4 只豁免变体专属副作用），故内核零新概念。
2. **`event_json` 字符串前端单点解析**：live/replay/restart 三路径同一解析函数，§5.11 深等不破；内核不引入 AcpEvent serde 结构，上游契约漂移面为零。
3. **终态红线**：`peri/agent_event_done` 仅 diagnostic 留痕，不产 session.completed（ADR-0017 turn_ledger 权威）。
4. **诚实覆盖**：`WIRE-EXTENSION` 为新 transport 分级；hitlPending 通道上游休眠（peri-acp 全源无发送者）不声明 cap；peri-07 TurnCommitted 载荷上游显式抑制——两者维持 SOURCE-ONLY，不冒充已消费。
5. **漂移修正**：canonical `session_info_update` 曾整包映射 `session.model-updated`，按 workbench 语义收敛为 `session.mode-updated`（mode 是包内必有事实；model/status 由 workbench 拆分，canonical typedPayload 保留原字段）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| normalizers+coverage+tool+events+replay 测试绿 | ✅ 44 文件 727 passed / 1 todo |
| 新增扩展映射 fixture ≥10 变体 | ✅ subagent×3、compact×2、rewind、suspend、retrying、budget、snapshot-meta、oauth×2、system、execution-failed、workflow、background、lsp、prediction、done、malformed、unknown ≈20 变体 |
| 覆盖清单 not-transported ≥14 项转出 | ✅ 28→12（16 项：12 normalized + 4 flattened-with-reason）；未达 issue 目标 20 的差额：hitl 三项上游通道休眠、peri-07 上游抑制载荷、11/18/19/20/27/28/36/44 为 tracer-only/无 carrier，逐项 followUp 已注明 |
| 双栈 parity 测试 | ✅ wireSemanticParity.test.ts（14 标准 kind × 双栈 + peri 扩展判别符 canonical=unknown 断言） |
| Rust 单测 | ✅ extension_wrap_tests 4 项绿（合并并发窗口内验证）；全 crate 测试因 #316 在途 turn_ledger WIP 暂不可编译，待其收工复跑 |
| SOURCE-ONLY 不得改标 normalized（A17） | ✅ 门禁测试双向一致断言保持，peri-06/07 等维持 not-transported |

## 测试处置

- 修改：`providerCoverage.test.ts`（SOURCE-ONLY 47→31、WIRE-EXTENSION 16 项 pin、peri mapper gate 改为「标准输出为零 + 扩展通道另计」）；`canonicalNormalizer.test.ts`（session_info_update 期望→session.mode-updated）。
- 新增：见改动清单。

## 证据

- 前端：`bunx vitest run src/domains/workbench/coverage src/domains/workbench/normalizers src/domains/tool src/domains/events src/__tests__/replay` → 44 files / 727 passed（exit 0）。
- Rust：`cargo test -p pylon-acp --lib extension_wrap` → 4 passed；`cargo check -p pylon-acp -p pylon-core` / `-p pylon` 干净。
- 覆盖重计：peri normalized 9→21、flattened 0→4、not-transported 28→12；全仓 SOURCE-ONLY 47→31、WIRE-EXTENSION 0→16。

## 与 spec 的偏差

- spec 未决项裁决：OAuth interactionId 铸造规则采用 `peri-oauth-<server_name>`（interaction.requested/resolved 语义事件），未回退 diagnostic——C12 契约兼容（secretInteractionProjection 测试不动）。
- spec P1-6（SAFE_TOOL_RENDERER summary_fields）：核查发现 `buildToolRenderModel` 已有 summaryFields 优先链，无需代码改动，仅字典数据补齐即生效——记录为「已存在，不重复实现」。
- Rust 全 crate 测试与 docs 模块维护地图同步：因 #316 在途域阻塞，转为收工后复跑（见未解问题）。

## 未解问题

1. #316 落地后需复跑 `cargo test -p pylon-acp -p pylon-core --lib` 与实机验收（webview2-mcp：peri 实会话 peri/agent_event 到达 + subagent/compact 渲染）。
2. 连接期 OAuth（host 级 sessionId="" 通知）当前被 stale-session 路径拒绝——需要宿主级 OAuth 事件面，另立 issue。
3. `git check-ignore` 确认 agents.yaml 不入库，本地字典与 agents.example.yaml 已同步；部署机需手动对齐。

## 并行交集

- `types.rs`/`client.rs`/`dispatcher/mod.rs` 与 #316 同文件不同区段（host_tools/terminal 门与 protocolVersion 校验）——本施工以 `git apply --cached` 只提交己方 hunk，不连带；#316 收工后其 hunks 以正常 diff 呈现。
- `workbenchProjector.ts`/`chatClient.ts`/`tauriTransport.ts`/`docs 模块维护地图` 有 #317/#316 在途改动，本施工**未触碰**。

## 审查轮（子 agent review 后修复，2026-09-25）

子 agent 双轴审查 overall=fail → 修复后转绿。逐项处置：

| 发现 | 级别 | 处置 |
| --- | --- | --- |
| PR 树 Rust caps 基线门禁红（provider_adapter 两处 pin / agent_config tests.rs pin / 9 个 golden jsonl 仍记 3 键） | fail | PR 分支补齐：两处 provider_adapter pin、tests.rs pin、10 个 jsonl 片段更新为 7 键；worktree 实跑 `cargo test -p pylon-core --lib` 118 passed + `cargo test --lib -- golden` 8 passed |
| P2-8（peri _meta 契约单源）未实施且未声明偏差 | fail | 已实施：`src/domains/events/periWireContract.ts`（caps 键 + usage `_meta` 载荷键 + skillNames 键单源）+ `periWireContract.test.ts` 逐字对照钉子；acpNormalizer 消费端全部改引常量 |
| _meta 深消费 / skillNames 零 fixture | warn | acpNormalizer.test.ts 补 2 例（正例 7 键 + 反例非数值/空集不伪造） |
| peri-12 误标 WIRE-EXTENSION（carrier 是标准 usage_update._meta，provider 中立层） | warn | 改归 WIRE-STANDARD；EXTENSION_CHANNEL_IDS/door test pin 同步 16→15 |
| acpNormalizer 注释「落 usage.raw」误导 | warn | 注释改为「投影为 usage 顶层具名字段，projector 侧不参与终态判定」 |
| caps 4/7 与转出 16/20 低于目标 | warn | 维持诚实披露（hitl 通道休眠经 peri-acp 全源核实；sourceAgentId 无条件注入不依赖声明） |

修正后计数：WIRE-EXTENSION 15 项（peri-12 归 WIRE-STANDARD）；其余计数不变。
