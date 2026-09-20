# ADR-0018 前端计算核选型 Rust/WASM

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/0018-frontend-compute-core-rust-wasm.md`

- **日期**：2026-09-21
- **状态**：已采用（语言选型由用户拍板，见 issue #220「语言裁决（已完成，用户拍板）：all in Rust（wasm-bindgen/wasm-pack）」）
- **议题**：issue #220（直接来源）；#205 / #212（性能动机）；#148 / #150（WP3/WP4 的前置收口）；#217（ADR-0017，WP2 的对齐约束）

## 背景与约束

前端 `src/`（1368 个 TS 文件、约 6.9 万行）的计算主体是两块**自声明纯函数**的数据核，
目前全部在 JS 侧运行：事件折叠/投影核（约 4–5k 行）与流式文本管线（约 1.5k 行）。
两者都是分配密集的文本处理，成本落在每一拍的增量解析 + row measure 上，长会话冷装载与
流式期间都压在 JS 堆上。

同时存在一项结构性问题：canonical 事件 schema 在 TS（`domains/events/eventSchema.ts`
的 `CANONICAL_EVENT_TYPES`）与 Rust（`session/event_repo.rs:35` 的 `CanonicalEventRow`，
`event_type` 是 `String` 且无枚举）各持一份。

**约束**（issue 原文，本次不可动）：插件四样契约（语义 kind / Slot 内容点 / fallback /
documentSchema）、单一投影实现纪律、揭示契约（D1 预算逐行递减、D2 UTF-16 计量不劈字素、
60fps 发布、400ms 追赶窗口）、活性权威（ADR-0017）、浏览器预览模式必须继续可用、
IPC wire 与持久化格式不变。

## 备选方案

| 方案 | 否决理由（issue 原文的裁决理由） |
| --- | --- |
| **Zig / C / C++** | ① canonical 类型在 Rust 侧已存在，换语言意味着 schema 三份维护，本立项最大的类型共享资产清零；② wasm-bindgen 的自动 TS 类型生成与结构编组无对等物，C/Zig 侧全手写 C ABI；③ Unicode 生态——D2 的命门是 UTF-16 计量与字素不劈分，Rust `unicode-segmentation` 是 UAX#29 参考实现，Zig std 无字素分段（等于自行移植 UAX#29），C 需拖 ICU（数 MB）；④ 状态核需长期演进，C/C++ 手动内存把 UAF 风险引入前端；⑤ markdown 引擎上 C 的 cmark 是唯一亮点，但 comrak 即其 Rust 直系后裔且更活跃。 |
| **投影搬进 Rust kernel（Rust 侧进程内）** | 「内核路线会把浏览器预览打成二等公民」——`bun run dev` 的 mock 数据路径没有 kernel 可依赖。 |
| **留在 JS，只做局部优化** | 计算仍在 JS 堆上；schema 双份漂移无解；无法同时服务 Tauri 与浏览器预览两种模式。 |

## 决定

**前端计算核 = Rust/WASM（wasm-bindgen + wasm-pack）。** 目标形态
**JS 编排 + WASM 计算核 + Solid DOM 消费层**。

配套的落点决定（本次实现层，服从上面的语言裁决）：

1. **canonical 类型单源**：新增 `pylon-canonical-types` crate，作为 `event_repo` 与计算核
   的共同依赖；TS 侧 `CANONICAL_EVENT_TYPES` 由单源导出对齐（WP1）。
2. **计算核落 `src-tauri/` 既有 workspace**，`crate-type = ["cdylib", "rlib"]`：
   wasm-bindgen 在非 wasm 目标可编译，于是纯逻辑既被 wasm-pack 打包、又能在宿主跑原生
   单测与 property test。放独立 workspace 会让 `check:rust` 的 `cargo test --workspace --lib`
   与 `cargo fmt --all` 漏掉它，等于重建 #106 P0 关掉的测试黑洞。
3. **WP4（markdown 引擎与高亮）独立 crate**：comrak / syntect 依赖重，且 syntect 默认
   feature 走 onig（C 依赖），wasm 目标须切 `fancy-regex`；与 WP2/WP3 隔离以免污染主核编译面。
4. **wasm 出口用 `--target web`**：产 ESM glue + `_bg.wasm`，`import.meta.url` 定位 wasm，
   Vite 与 vitest 两侧都可消费；不引入 bundler-target 的 webpack 假设。
5. **迁移期双实现只允许存在于差分校验阶段，且 TS 侧退役必须在 parity 绿之后**，
   不得留下长期双实现（issue 原文约束）。

## 后果

- **正面**：投影折叠与增量解析离开 JS 堆；同一 WASM 内核同时服务 Tauri 与浏览器预览；
  canonical 类型单一事实源，漂移由编译器而非人读兜底；typing 由 wasm-bindgen 生成。
- **负面 / 代价**：计算核改动不再被 HMR 覆盖（需 wasm 重编）——已接受的代价，WP 划分使
  调试活跃区（DOM 消费层）仍走 HMR；开发机与 CI 都新增 wasm 工具链前置（本机开工时缺失，
  已补；CI 侧见 spec 未决问题 1）；前端多一份需记账的 wasm 产物（`check:bundle` 扩展）。
- **风险**：
  1. **字符语义差分**——JS `Intl.Segmenter` 与 UAX#29（`unicode-segmentation`）在 emoji ZWJ、
     regional indicator 等边角存在差异；且 D2 按 UTF-16 计量而 Rust 字符串是 UTF-8。
     对策：property test + 差分 corpus 专攻边角。
  2. **文本双份镜像漂移**——domain 权威文本与 WASM 镜像可能漂移（#55 同类 bug 的新家）。
     对策：单写者 API（仅 `reset`/`feed` 可改镜像），漂移可断言。
  3. **markdown 引擎边缘行为差异**——unified 与 comrak 在规范边缘可能渲染不同。
     对策：已渲染快照回归 + 差异清单逐条过审后接受或修补。
  4. **回滚**：TS 基线保留至 parity 绿 + 切流后一个发布周期，提供 feature 级回退点；
     WP1 类型 crate 独立无回滚风险。

## 证据

- 计算面清单与行数：`.agents/spec/220-frontend-compute-core-wasm.md`「现状」表（按实际
  `file:line` 重核；issue 正文有三条路径已过时，spec 已勘误）。
- schema 双份与「无门禁」的实测：`src/domains/events/eventSchema.ts:23`
  （`CANONICAL_EVENT_TYPES`）对 `src-tauri/src/session/event_repo.rs:35`
  （`CanonicalEventRow.event_type: String`）；`scripts/` 下无该对齐门禁。
- 工具链可行性：`wasm-pack 0.14.0` + `wasm32-unknown-unknown` 冒烟构建成功
  （产出 ESM glue 与 `_bg.wasm`，wasm-opt 通过）。
- 差分校验形态先例：`scripts/check-acp-shadow-parity.mjs`；增量解析方向先例：ADR-0006。
- 活性权威约束：ADR-0017（`src-tauri` 侧在途回合事实）。
