# Dev Record — 220 前端计算核下沉 Rust/WASM（WP1 分片）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/<issue>-<slug>.md`

**本文只覆盖 WP1。** issue #220 的 WP2/WP3/WP4 未在本轮开工，原因与现状见「与 spec 的偏差」。

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/220（refactor；assignee 已设 `AlchemistCxC`）
- 分支：`Ru5t/Reflector`（开工 `git status` 干净，ff 到 `github/main` `5e251b40`）
- 提交范围：`5e251b40..<本记录所在提交>`
- 日期：2026-09-21
- spec：`.agents/spec/220-frontend-compute-core-wasm.md`（一次性，不入库）
- ADR：`.agents/decisions/0018-frontend-compute-core-rust-wasm.md`（入库）

## 目标与范围

**做**：WP1——canonical 事件类型单源化，`src-tauri/event_repo` 与 WASM crate 共享；
把 wasm 工具链、构建步骤、产物记账与 parity 门禁一次性打通，使 WP2 起可以直接写计算逻辑。

**不做**（issue 原文约束）：不动插件四样契约与任何 Suite 接缝；不动 IPC wire 与持久化格式；
不把投影搬进 Rust kernel；不动渲染 DOM 层；不新增白名单豁免。WP2/WP3/WP4 的投影与流式
逻辑迁移本轮未开工。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-canonical-types/**` | 新 crate：词表宏 + `CanonicalEventType` + `canonical_event_type_for` + owner key / eventId / sequence 纯原语 + 9 个单测 | 新增 |
| `src-tauri/pylon-compute/**` | 新 crate（cdylib+rlib）：wasm 出口层 `canonical`（纯内层 + `#[wasm_bindgen]` 薄壳）+ 5 个单测；`[package.metadata.wasm-pack.profile.release]` 的 wasm-opt 特性开关 | 新增 |
| `src-tauri/Cargo.toml` | workspace members 增两 crate；主 crate 增 `pylon-canonical-types` 依赖 | 修改 |
| `src-tauri/Cargo.lock` | 新依赖解析（`pylon-canonical-types` / `pylon-compute` / `serde-wasm-bindgen` / `wasm-bindgen` / `js-sys`） | 修改 |
| `src-tauri/src/session/event_repo.rs` | `normalize_kernel_event` 的判别符 switch → 单源调用（`unknown` 归因打点保留）；三处 `event_id`/owner key 推导改走单源 | 修改 |
| `src/domains/events/canonicalEventTypes.generated.ts` | 由 Rust 生成的 TS 词表 | 新增 |
| `src/domains/events/eventSchema.ts` | 手抄的词表数组 → 再导出生成物 | 修改 |
| `src/infrastructure/compute/pylonCompute.ts` | wasm 装载与出口（浏览器/Vite 路径 + Node/vitest 路径） | 新增 |
| `src/infrastructure/compute/__tests__/pylonCompute.test.ts` | TS↔WASM parity witness（10 例） | 新增 |
| `scripts/build-wasm.mjs` | wasm 构建（工具链探测 + 源码哈希跳过 + 产物字节记账） | 新增 |
| `scripts/vitest-wasm-setup.mts` | vitest globalSetup：确保 wasm 产物存在 | 新增 |
| `scripts/generate-canonical-event-types.mjs` | 词表 TS 生成器 + `--check` 门禁 | 新增 |
| `scripts/check-bundle-size.mjs` | wasm 产物独立记账与预算 | 修改 |
| `vitest.config.ts` | `test.globalSetup` | 修改 |
| `package.json` | `build:wasm` / `build:canonical-types` / `check:canonical-types`；`check:frontend(:static)` 增两步 | 修改 |
| `tsconfig.json` / `eslint.config.js` | 排除 `src/wasm`（构建产物，参数名是 Rust snake_case） | 修改 |
| `.github/workflows/ci.yml` | `frontend` / `frontend-test` 两 job 增 wasm 工具链 + wasm-pack + `src/wasm` 缓存 | 修改 |
| `.agents/L.md` | #220 施工域声明（含与 #217 的重叠报备） | 修改 |
| `.agents/decisions/0018-*.md` | 选型 ADR | 新增 |

## 方案要点

1. **单源在 Rust，TS 是派生物**。`pylon-canonical-types` 用 `canonical_event_types!` 宏把
   `Variant => "wire"` 列表一次展开成 enum / `as_str` / `from_wire` / 词表数组四者——
   宏内不可能互相漂移，因此「源码里的那份列表」就是唯一事实源。TS 侧由
   `generate-canonical-event-types.mjs` 读该宏调用生成，`eventSchema.ts` 只再导出。
2. **两 crate 落 `src-tauri` 既有 workspace，而不是另起 workspace**。`check:rust` 的
   `cargo test --workspace --lib` 与 `cargo fmt --all` 才能覆盖它们；另起 workspace 等于
   重建 #106 P0 刚关掉的「子 crate 测试黑洞」。
3. **`crate-type = ["cdylib", "rlib"]`**：wasm-bindgen 在非 wasm 目标可编译，于是同一份纯
   逻辑既能被 wasm-pack 打包，也能在宿主跑原生单测（WP3 的 D1/D2 property test 靠这个）。
4. **计算核分「纯内层 + wasm 薄壳」两层**。这不是风格问题：`JsError::new` 在非 wasm 目标上会
   走导入桩并 **panic**（`cannot call wasm-bindgen imported functions on non-wasm targets`），
   实测把可失败路径写在 wasm 壳里会让宿主测试直接炸。因此可失败逻辑一律进纯内层
   （`Result<T, String>`），壳只做值/错误转换。WP2/WP3 必须沿用这条分层。
5. **wasm 工具链是新增的硬前置**（本机开工时 `wasm32-unknown-unknown` 与 `wasm-pack` 都缺）。
   构建走 `scripts/build-wasm.mjs`（源码哈希做戳，未变即跳过 `<100ms>`，缺工具链时报出补齐
   命令而不是 `command not found`），并挂到 vitest `globalSetup`，覆盖 watch 与编辑器入口。
6. **wasm-opt 特性开关必须与 rustc 对齐**。rustc 1.82 起为 wasm32-unknown-unknown 默认打开
   bulk-memory 等特性，而 wasm-pack 0.14.0 捆绑的 wasm-opt 是 binaryen 117（2023），默认特性集
   更旧 → `-O` 直接验证失败。已在 `pylon-compute/Cargo.toml` 显式打开所需特性。
   **本仓此前从未有过 wasm 目标**，这类「工具链版本差」是新增依赖面的固有成本。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 词表单源（Rust → TS 生成，无手抄） | **达成**：`bun run check:canonical-types` → 与 Rust 单源一致（22 项） |
| `event_repo` 消费单源且行为不变 | **达成**：`cargo test -p pylon --lib -- session::event_repo` → 56 passed / 0 failed |
| WASM crate 共享同一词表（Rust 侧） | **达成**：`cargo test -p pylon-canonical-types -p pylon-compute --lib` → 9 + 5 passed / 0 failed |
| WASM crate 共享同一词表（**过 wasm 边界**） | **达成**：`pylonCompute.test.ts` 10 passed（词表逐项、判别符×status 全组合、identity 逐字节、非整数 sequence fail-closed） |
| 浏览器路径的 wasm 产物接入 | **达成（探针验证）**：临时从 `main.tsx` 引入 loader 后 `bun run build` 产出 `dist/assets/pylon_compute_bg-*.wasm` 50,951 B，`new URL(..., import.meta.url)` 被 Vite 正确接成资源；探针已还原 |
| `check:bundle` 对 wasm 产物记账 | **达成**：新增 wasm 预算段，实测 onig 473,151 B + 计算核 50,951 B，gzip 合计 185,351 / 预算 200,000 |
| `check:frontend` 增 wasm 构建步骤 | **达成**（`build:wasm` 已入链）；**但当轮未能跑绿**，原因见下 |
| parity 差分全 corpus、TS 基线退役 | **未达成**：属 WP2–WP4 范围，本轮未开工 |
| 性能证据（webview2-mcp 实机） | **未达成**：需已迁移核与实机，本轮未开工 |
| 浏览器预览模式回归 | **未达成**：同上 |
| 文档同步（架构参考 / 模块维护地图 / dev-standards） | **部分**：dev-standards 与模块维护地图已补；架构参考待最终 WP（#217 也声明了该文件） |

## 测试处置

- 新增：Rust 9（`pylon-canonical-types`）+ 5（`pylon-compute`）= 14 例；TS 1 文件 10 例。
- 修改/删除既有测试：**无**。TS 既有行为测试一条未改，`event_repo` 既有 56 例逐条通过。

## 证据

- commit：本记录所在提交（见 `git log -- .agents/records/220-*.md`）。
- 测试：
  - `cargo test -p pylon --lib -- session::event_repo` → `56 passed; 0 failed`（exit 0）
  - `cargo test -p pylon-canonical-types -p pylon-compute --lib` → `9 passed` + `5 passed; 0 failed`（exit 0）
  - `bun run test src/infrastructure/compute` → `Test Files 1 passed / Tests 10 passed`（exit 0）
  - `bun run lint` → `0 errors, 1 warning`（warning 在 `RightRailHost.tsx`，本轮未触碰，属既存）
  - `bunx tsc -b` → exit 0
  - `cargo fmt --all --check` → 通过
  - `bun run check:bundle` → `bundle budget 通过`（wasm 185,351 / 200,000）
  - `bun scripts/build-wasm.mjs` → 产物 50,939 B raw（wasm-opt 后），未变时跳过
- 手工验证：
  - wasm-pack 冒烟：最小 crate `--target web` 全链路（cargo → wasm-bindgen → wasm-opt）通过。
  - 浏览器产物探针：见上表「浏览器路径的 wasm 产物接入」。
  - `rustup target add wasm32-unknown-unknown` 与 wasm-pack 0.14.0 安装（本机开工时均缺）。

## 与 spec 的偏差

1. **WP2/WP3/WP4 未开工**。spec 与 issue 要求「四个工作包一次做完」，本轮只交了 WP1。
   原因：WP1 落实后本仓第一次有了 wasm 工具链、构建步骤、产物记账与过 wasm 边界的 parity
   门禁——这些是 WP2 起的前置，且它们的取舍（是否让所有前端贡献者装 wasm-pack、CI 两个
   job 的编译面扩张、wasm 预算定标）需要仓库主裁决（见「未解问题」）。在裁决前把 4–5k 行投影
   逻辑搬过去，会把一个未定的基础设施决策和一次大规模语义迁移绑在同一个提交里。
2. **spec 里「TS 侧由生成物替代手抄」做到了**（spec 原本只承诺 parity 门禁）。生成器读 Rust
   宏调用，少了「两处手抄 + 门禁兜底」这一层。
3. **spec 未预告的两处实现发现**（已写进本记录与 ADR，WP2 必须沿用）：
   - `JsError` 在非 wasm 目标 panic → 计算核必须「纯内层 + wasm 薄壳」分层；
   - wasm-opt 特性开关必须与 rustc 默认特性对齐（见方案要点 6）。

## 未解问题

1. **wasm 工具链成为所有前端贡献者与两个 CI job 的前置**。本机开工时缺 target 与 wasm-pack；
   CI 已在 `frontend` / `frontend-test` 两 job 补装（dtolnay + 预编译 wasm-pack + `src/wasm` 缓存）。
   替代方案是**把 wasm 产物入库**（前端 job 无需 Rust），代价是仓库里多一份二进制生成物。
   两条路都可行，本记录取「按 issue 要求构建」的一条，**请仓库主确认**。
2. **wasm 预算 200,000（gzip）的定标**只覆盖 onig + 计算核；WP4（comrak + syntect）预计显著
   抬高该项，届时必须按实产物重定标。
3. **WP4 的 crate 位置**（spec 里写在仓根 `wasm-markdown/`，不在 `src-tauri` workspace）需要确认：
   放外面会让 `cargo fmt --all` / `cargo test --workspace` 漏掉它，与方案要点 2 的理由冲突。

## 并行交集

共享工作树上，#217（ADR-0017）正在施工，我观测到它同一时段在改
`src-tauri/src/session/{model.rs,prompt.rs,runtime.rs}`、
`src/domains/workbench/{workbenchRuntime.ts,generationLedgerSummary.ts}`、
`src/infrastructure/acp/sessionClient.ts`、`src/sheets/agent-workbench/agentWorkbenchSession.ts`。

- **我未触碰上述任一文件**；我的改动与之无文件交叉。
- 重叠声明：`docs/说明书/Pylon-项目架构参考.md` 与 `.agents/records/` 两边都声明了。本轮我只写
  了本记录文件，架构参考的 WASM 一节留到最终 WP。
- `src-tauri/Cargo.lock` 我因新增依赖而改写；若 #217 也加依赖，按「两边都保留」处理。
- **当轮无法跑绿 `bun run build` / `check:frontend`**：`tsc -b` 报
  `src/sheets/agent-workbench/agentWorkbenchSession.ts(11,49): error TS6133: 'resolveKernelLiveness'
  is declared but its value is never read` —— 该文件属 #217 在途施工（他们刚加了 import 尚未使用），
  与本轮改动无关。我因此未能给出 `check:frontend` 全绿证据，改用分项证据（见「证据」）。
  **#217 收工后需由其中一方复跑 `check:all` 补齐这条证据。**
