# Dev Record — #271 删除启动诊断 hermes profile 探测链

> 入库保留。范围与依据承接 issue #271 正文（含 2026-09-23 实验证据）。

## 元信息

- issue：#271
- 分支：`kumo/prometheus`（堆叠 PR #268）
- 提交范围：`6d9306c7..`（本条）
- 日期：2026-09-24

## 目标与范围

删除窗口前的 hermes profile 诊断探测（`HERMES_HOME` 缺失时 PATH 全扫描）：`build_hermes_profile_view` + 快照字段 + 前端契约/徽章/样例。**保留连接期 `HERMES_HOME` 注入链**（`launch_plan` → `hermes_home_override`，功能承重——不注入则配 profile 的 hermes agent 静默跑错 profile，2026-09-23 实测证据见 issue）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/startup.rs` | 删 `HermesProfileView` 结构、`StartupDiagnostics.hermes_profile` 字段、`build_startup_diagnostics` 尾参、`test_default` 字段、`hermes_profile_view_serializes_without_home_path` 用例、3 处调用点尾参 | 修改 |
| `src-tauri/src/lib.rs` | 删 `build_hermes_profile_view` 及调用（快照构建点留一行去向注释） | 修改 |
| `src/infrastructure/tauri/runtimeLogContracts.ts` | 删 `HermesProfileDiagnostics` 接口、`hermesProfile` 字段、`normalizeHermesProfile` 及 spread | 修改 |
| `src/infrastructure/tauri/__tests__/tauriClients.test.ts` | 删 2 个 hermes normalize 用例；保留域缺省用例并改写为 storage 域覆盖 | 修改 |
| `src/sheets/RuntimeSheetView.tsx` | 删启动诊断区 hermes 徽章 | 修改 |
| `src/demo/demoData.ts` | 删 `buildStartupDiagnostics` 的 hermesProfile 样例 | 修改 |

## 方案要点

- 纯减法。`normalizeStartupDiagnostics` 本就宽容（未知字段忽略），后端先行删除不破坏前端旧版本——wire 向后兼容。
- 保留面核验：`detect_hermes_home`/`resolve_profile_dir`/`hermes_home_override`/`launch_plan` 注入链零改动；`AgentDef.hermes_profile` 配置字段零改动。
- 注入语义的实机再验证：#270 验收日志出现 `HERMES_HOME set to F:\Hermes\profiles\riccati (hermes_profile)`（2026-09-24），注入链工作正常。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 零残留（`hermesProfile`/`HermesProfileView`/`build_hermes_profile_view` 全仓 grep 为空） | ✅ |
| 保留链不动 | ✅ `pylon-core/hermes/**`、`launch_plan.rs` 零 diff |
| cargo lib | ✅ 808 passed（-1 = 删除的 hermes 用例） |
| clippy | ✅ 零新增（现存 6 条均在既有文件） |
| `tsc -b` | ✅ 0 错误 |
| vitest 定向（runtimeLogContracts/RuntimeSheetView/demo） | ✅ 13 文件 / 72 用例绿 |
| vitest 全量 | ✅ 见 issue 回写 |

## 测试处置

修改/删除既有行为测试（逐个登记）：
- 删 `tauriClients.test.ts`「hermesProfile 宽容 normalize（含 configured/resolved/profiles）」
- 改写 `tauriClients.test.ts`「hermesProfile 缺失/损坏时保持缺省」→「缺失/损坏域保持缺省」（storage 域替代覆盖，hermes 断言随域删除）
- 删 `startup.rs`「hermes_profile_view_serializes_without_home_path」

## 证据

- commit：本条
- 门禁输出：见 issue #271 回写
- 手工验证：启动诊断面板不再出现 hermes 徽章（后续实机启动顺带核验，`startup_diagnostics` 其余域正常返回）

## 与 spec 的偏差

无独立 spec 文件——issue 正文即删除清单与约束，本记录承接。

## 未解问题

无。

## 并行交集

`startup.rs`/`lib.rs` 与 #270 同日先后施工（其已收口提交）；`runtimeLogContracts.ts` 首次动域。全程 pathspec，#272 在途文件零触碰。
