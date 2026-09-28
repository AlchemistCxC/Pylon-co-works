# Dev Record — #424 private_ext 方言信封搬宿主 + 协议适配注册面 per-provider 槽化

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#424（#417 裁决第 5 项；仓库主批复：注册面选 per-provider 槽，append-only 形态否决）
- 分支：`kumo/424-private-ext-slots`（隔离 worktree `G:/Project/prism-team-workdir/pylon-424`；共享树 4 个 CSS/tsx 脏文件与 main 进站改动重叠无法安全 merge，按 #352/#353/#425 先例）
- 提交范围：`48bc31c0..HEAD`
- 日期：2026-09-28

## 目标与范围

**达成**（issue 目标结构原文）：
1. method 表值升级 per-provider 槽（保留 peri/hermes 双注册事实，诊断位还原真值），分派真源仍是 method 表。
2. private_ext 正身迁宿主 `protocol_adapter` 域。
3. catalog 三源投影（注册表/探测/catalog）行为不变、诊断位翻真。

**不做的**：question_policy/plan_policy/protocol.rs/permission_wire 通用解析知识不动；不做 append-only 登记日志；不引入 provider-preferring 分派新 API（#98「provider 非 gate」保持）；不碰 #423 InteractionLedger 三 store 域（同域错开施工）；前端/CSS 零接触。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-acp/src/adapter/private_ext/mod.rs` → `src-tauri/src/protocol_adapter/private_ext.rs` | 整文件（376 行含测试）；仅改 1 行 import（`crate::` → `pylon_acp::`） | 重命名（跨 crate 搬移） |
| `src-tauri/pylon-acp/src/adapter/interaction_bridge.rs` → `src-tauri/src/protocol_adapter/interaction_bridge.rs` | 整文件；import 改跨 crate + 头注更新为迁宿主语境 | 重命名（跨 crate 搬移，随迁件） |
| `src-tauri/src/protocol_adapter.rs` → `src-tauri/src/protocol_adapter/mod.rs` | 升格目录；+模块头（#424 域说明）+ 两子模块声明；注册/查询/catalog 三段重写；新增 1 测试 | 重命名 + 修改 |
| `src-tauri/pylon-acp/src/adapter/mod.rs` | 摘除 `interaction_bridge`/`private_ext` 两 mod，头注说明残件与去向 | 修改 |
| `src-tauri/src/dispatcher/interaction_route.rs` | 消费点路径改写 `crate::acp::adapter::private_ext::` → `crate::protocol_adapter::private_ext::`（生产 + 测试块）+ fmt 重排 | 修改 |
| `src-tauri/src/permission.rs` | 同上路径改写（含测试块）；`pylon_acp::adapter::interaction_bridge::timeout_default_response` → `crate::protocol_adapter::`；两处过时注释更新（respond 兜底/超时回包） | 修改 |
| `src-tauri/src/private_interaction.rs` | `PendingPrivateInteraction.bridge` 字段类型路径改写 + 测试 | 修改 |
| `src-tauri/src/lib.rs` | `install_process_registrations` 注册点注释 +1 行（#424 双注册事实说明） | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | crate 表 pylon-acp 行：adapter/ 内容清单同步 | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | Native ACP 行：adapter 模块清单 + 宿主 protocol_adapter 域说明 | 修改 |

## 方案要点

1. **搬移是编译依赖方向的强制推论**：private_ext 生产消费点全在宿主（dispatcher/permission/private_interaction）；pylon-acp 内唯一消费者 interaction_bridge.rs（#416 下沉的超时裁决表）的唯一消费者又是宿主 permission.rs——private_ext 出仓后它必须随迁，否则 pylon-acp 反向依赖宿主。
2. **两表合一**：`PROTOCOL_ADAPTERS`（provider 键控，last-writer-wins-per-provider）删除；`PROTOCOL_METHOD_ADAPTERS` 值升格 `BTreeMap<provider, AdapterRef>` 槽。#416 W2 wave2 步骤 7 因「反向投影翻假」搁置的注册表合并就此清偿——per-provider 槽让反向投影无损。
3. **分派语义保持**：`get_protocol_adapter_for_method` 槽非空即受理、取 BTreeMap 键序首槽（确定性；现网注册集下与旧 last-writer-wins 结果一致——hermes 恰为键序首且为旧后写者；peri/hermes 审批 wire 逐字段一致（R2-WI06），槽选择不进入 wire）。#98「provider 非 gate」不变。
4. **catalog 反向投影**：provider 的 `adapter_methods` = 持槽 method 全集、`response_methods`/`interaction_kinds` = 各槽适配器并集、display 名兜底取槽内适配器原名；对现网单 method 适配器与旧 provider 表逐字段一致。副产品：旧表「同 provider 后注册适配器覆盖前者声明」的隐性丢失消除。
5. 空 `interaction_methods()` 适配器不占槽（无协议面可登记；现状生产无此类，trait 默认值本为第三方源兼容保留）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 既有行为测试全绿且未被修改 | ✅ protocol_adapter 全部既有测试（注册表/探测/catalog 三源/respond 拒绝面）、private_ext 7 条内联测试（平移不改）、#356 五回归均绿；diff 中零测试修改 |
| `adapter_registered` 对 peri/hermes 均为真值（新增断言） | ✅ 新增 `catalog_reverse_projection_keeps_both_providers_registered`（双注册 → 两 provider registered=true + methods 含 session/request_permission + kinds 含 approval） |
| wire 零变化 | ✅ `bun run check:acp-shadow` exit 0（golden 逐字节 parity） |
| 门禁全绿 | ✅ 见证据节 |

## 测试处置

- 新增：`protocol_adapter::tests::catalog_reverse_projection_keeps_both_providers_registered`。
- 修改/删除既有行为测试：无。private_ext/interaction_bridge 的内联测试随文件平移（git rename 保历史），断言零改动。

## 证据

- commit：`refactor(#424)`（worktree 分支 `kumo/424-private-ext-slots`，基准 `48bc31c0`）
- 测试（均 exit 0）：
  - `cargo test -p pylon-acp --lib`：186 passed / 0 failed
  - `cargo test -p pylon --lib`：933 passed / 0 failed（4 ignored 既有）
  - `cargo test --workspace --lib`：9 目标全 ok，合计 1591 passed / 0 failed
  - `bun run check:clippy`：exit 0（基线外新增诊断为空；首跑报 `clippy::type_complexity`，已按建议抽 `ProviderSlots`/`MethodAdapterTable`/`RegisteredProviderView` 类型别名修复）
  - `cargo fmt --all --check`：干净
  - `bun run check:acp-shadow`：exit 0（golden 双轮 parity）
- 前置：`cargo build -p pylon-fake-agent --features test-agent`（pylon-acp 测试依赖；不构建时 `wire_bridge_records_*` 会因找不到 bin 红——本仓既有前置，非本批引入）
- 手工验证：无 GUI 改动，不需要实机验收（纯 Rust 结构搬移 + 注册形状，全部行为面由上述单测/golden 钉死）。

## 与 spec 的偏差

- spec 方案 B 预估 catalog 投影用元组（String, BTreeSet×3），实现改为命名字段结构体 `RegisteredProviderView`——clippy `type_complexity` 门禁强制，语义相同。
- 无其他偏差。

## 未解问题

- 无阻塞项。备注两点非本批范围：① provider-preferring 分派（按请求方 provider 选槽）未做——现网槽内适配器 wire 等价，无行为需求；#423 若需要可在槽结构上加。② `get_protocol_adapter` 仍保留 `#[allow(dead_code)]`（消费面是 test_utils 断言，非生产路径）。

## 并行交集

- 共享树：仅 `.agents/L.md`（开工声明 a57a7883）与 `.agents/spec/424-*.md`（不入库）。
- worktree 域：`src-tauri/pylon-acp/src/adapter/**`、`src-tauri/src/protocol_adapter*`、`src-tauri/src/{permission,private_interaction}.rs`、`src-tauri/src/dispatcher/interaction_route.rs`、`src-tauri/src/lib.rs`（仅注释行）、`docs/说明书/{Pylon-项目架构参考,Pylon-模块维护地图}.md`。#423 审批线收口批与本批文件域重叠（protocol_adapter/permission.rs），本批已收口，#423 可开工。
