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

---

## 修订 1（2026-09-21）· scope 收窄：wasm 只留 markdown + 流式

**状态**：已生效（同日在 `Ru5t/Reflector` 上落地，PR #222 内）。

### 改了什么

原决策「前端计算核下沉 Rust/WASM」覆盖 WP1–WP4 四包。修订后**只保留两处**：

| 面 | 去向 |
| --- | --- |
| WP2 投影核 | **回退 TS**（`src/domains/workbench/workbenchProjector.ts` 恢复为活实现） |
| events 层 | **回退 TS**：Rust 侧删除；前端 TS 一直就是跑着的那份（`canonicalEventSink.ts` 从未切流） |
| `canonical` 段（词表/wire 映射/identity 推导） | 随其上两个消费者一并删除 |
| WP3 流式（切分 + 揭示预算引擎） | **保留在 wasm** |
| WP4 markdown 解析 / 高亮 | **保留在 wasm** |
| WP1 `pylon-canonical-types` | **保留**——它服务的是**代码生成**（`scripts/generate-canonical-event-types.mjs` 产出 TS 词表），本来就不是 wasm 机制 |

判据收敛成一句：**只留「同形状对照里真的赢」的那些。**

### 依据（全部为本仓实测，不是判断）

1. **投影速度**：现实入口 `fold mixed-m` **1.12×**、`paged-replay-m` **1.92×**；合成 delta 形
   6.75× 的根因是 **Rust 折叠本体比 TS 整条管线慢数倍/事件**（`foldPhases` 核内 project
   相位 vs TS 全管线），属数据模型问题、非边界问题 —— 重构天花板也只是「打平」。
2. **投影内存（决定性）**：文档必须在计算核里与 JS 里**各存一份**。同 workload、逐字节等量
   形状下的持有成本实测 **① TS 文档 0.36MiB vs ② wasm（核内 + JS 物化）1.59MiB = 4.4×**；
   mixed 形 0.50 vs 3.04 = **6.1×**。核线性内存峰值保留 8.19/14.38MiB（22.8×/29.0×）。
   「文档两份」是结构成本 —— 已落地的 `EventPayload` 定长载荷（把**文档**缩到 0.5×）也
   碰不到它，因为它缩的是其中一份、另一份照旧。
3. **events 速度**：wasm 出口比它要替换的 TS **慢 9–71×**（`normalizeRawEvent` 8.03 vs
   0.87ms、`canonicalBatchSpanOf` 1.26 vs 0.02ms），因为逐事件 `serde_wasm_bindgen` 双向往返。
   ⇒ **把 events 迁移做完等于主动引进回退**，故不是「继续迁移」而是「删 Rust 侧」。
4. **保留方的对照读数**：markdown 生产**流式形状**（每帧只解析增长短尾）**12–25×**
   （一次完整流式回合 10.94ms → 0.39ms；TS 侧的固定成本是「每次调用重建 unified 管线」，
   0.3–0.5ms 起，不随输入缩小）；流式切分大输入 2–3×（`blocks-m` 0.31×）；揭示预算 burst 档
   0.6–0.9×。这几处是**同形状**下的真赢。
5. **路径依赖**：投影的调用点是**同步**的（乐观发送 / session response / refresh 兜底），
   而 wasm 在浏览器宿主异步初始化 ⇒ 需要「bootstrap 预热 + 装载门」这类额外机制
   （真机验收曾因此抓到一个首次使用竞态）。回退 TS 后这类机制一并消失。
   流式不在此列：它由渲染器 suite 的 `prepare()` 收敛，与调用点天然异步对齐。

### 被否证的替代路线（记下来省后人一次弯路）

- **「live 折叠合批」当优化**：不成立。系统里那个 32 行 / 8ms 的有界窗口是
  **durable append 之前**的持久化批，不是投递批；把投递也合批会让「现实」被「历史」的批
  节奏拖住，而 `kernel > clock > document`、per-frame 投递、durable-before-project 这一整套
  设计正是为了让现实即时可见。**这是语义边界，不是性能余地。**
- **换高性能库**：不成立。慢的不是算法或解析器，是数据模型（`serde_json::Value` 每对象一棵
  BTreeMap）与**逐事件过界**；库能碰到的只有 `patchJson` 1–2.6µs + `JSON.parse` 2.2µs，
  占不到 15%。
- **SharedArrayBuffer 零拷贝**：不成立。边界上真正可省的只有输入侧一次 memcpy，而它**∝字节**：
  live 单事件帧 289B ≈ **0.03µs / 30µs（0.1%）**，冷页 558KB ≈ **0.2%**。亏的是**逐次调用的
  固定开销**（核外 ~9µs/次），零拷贝消不掉它。且 SAB 还需要 `crossOriginIsolated`
  （COOP+COEP 头，会波及全部子资源），换来的主要是 wasm threads / worker 间零拷贝 ——
  那对应「把计算移出主线程」这个 **UX** 目标，不是吞吐。要零拷贝输入，正确工具是
  「wasm 里开 scratch + JS 拿视图写」，不需要 SAB。
- **events 下沉 kernel**：不值得为性能做。events TS 侧唯一逐事件的成本是
  `normalizeRawEvent` ~7.3µs/事件（按 500 事件/s = 单核 0.4%）；下沉只是把这 0.4% 从
  前端搬到内核（同一算法的 native 版），换来一个新 IPC 契约，且我手上没有前端 raw rows 的
  占用读数 ⇒ 无法承诺内存收益。若将来前端主线程真的紧张，再评估，届时先量「前端 raw rows
  占用」与「normalize 的主线程占用」。

### 后果

- `pylon-compute` wasm 产物 **841,273 B → 119,788 B**（gzip 307,257 → **53,238 B**）；
  wasm 总 gzip **1,216,820 → 962,801 B（−254 KB ≈ −21%）**。`check-bundle-size.mjs` 的
  wasm 预算已按实产物重定标（1,450,000 → 1,110,000），否则这一档会放空 50%。
- 文档回到**单份**；「核就绪」这一整类机制与竞态消失。
- 差分门禁少了两域（parity 148 → 98 项）。**markdown 的产品路径快照锁保留** ——
  那是门禁不是 benchmark（`markdownComputeParity.test.ts` 的 markdown 半）。
- 保留的对照面 = 流式两项；其 TS 基线（`oldStreamingMarkdownSplit` / `oldRevealEngine`）
  与冻结基线一并保留，作为回退点。

### 不变的部分

- **`pylon-canonical-types` 的单源地位不变**：`canonicalEventTypes.generated.ts` 仍由它生成，
  `check:canonical-types` 仍在门禁链上（实测「与 Rust 单源一致（22 项）」）。
- **`check:csp` 与那次 CSP P0 的修复不变**：打包态 `connect-src` 缺 `'self'` 曾使 wasm
  在发行包里从未加载（真机验收 §25.1）。wasm 仍有 markdown 与流式两个产物，这条门禁继续有效。
- 本 ADR 的**方法论**不变：跨语言计算核只有在「同形状、等量工作、可复现」的对照下才谈收益。
