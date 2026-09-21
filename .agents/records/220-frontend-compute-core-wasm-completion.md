# Dev Record — 220 前端计算核下沉 Rust/WASM（WP2–WP4 与旧实现退役）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/<issue>-<slug>.md`
>
> WP1 分片见 [`220-frontend-compute-core-wasm-wp1.md`](220-frontend-compute-core-wasm-wp1.md)。

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/220（refactor；assignee `AlchemistCxC`）
- PR：https://github.com/AlchemistCxC/Pylon-co-works/pull/222（分支 `Ru5t/Reflector`）
- 日期：2026-09-21
- spec：`.agents/spec/220-frontend-compute-core-wasm.md`（一次性，不入库）
- ADR：[`0018-frontend-compute-core-rust-wasm.md`](../decisions/0018-frontend-compute-core-rust-wasm.md)（入库）

## 目标与范围

**做**：WP2（投影核）、WP3（流式切分 + 揭示预算引擎）、WP4（markdown 引擎与高亮）三包
计算逻辑进驻 Rust/WASM；各自的 TS 实现**切流后删除**（用户要求：「完成计算核wasm化后
别忘记删除旧实现」）；按用户 2026-09-21 的边界纪律落地喂法，并用 mock 基准以数字决断。

**不做**：插件四样契约与 Suite 接缝零接触；IPC wire 与持久化格式不变；不把投影搬进
Rust kernel；不动渲染 DOM 层。`src/components/chat/starryCore.ts` **刻意保留**——按 issue
原文「TS 基线保留至 parity 绿 + 切流后一个发布周期，提供 feature 级回退点」，它现在是
高亮 parity 门禁的 TS 侧驱动，随门禁退役时一并删。

## 改动清单

### WP2 · 投影核（fold 退役）

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-compute/src/projector/*.rs` | events 层之外的投影：`content_part`（contentPartSchema 全覆盖）、`coverage`（ADR-0016 span 占用）、`workbench`（折叠主干 + 全部归约器 + PYPB v2 帧解码 + 增量 patch）、`session_surface` / `goal_model` / `lifecycle_model` / `event_schema` | 新增 |
| `src/infrastructure/compute/projectorCompute.ts` | 帧 v2 编码（词表 u32 索引 + 字串池）、patch/document 物化、边界过界计数、会话句柄 | 新增 |
| `src/domains/workbench/workbenchProjector.ts` | 1626 → 410 行：删掉全部归约器与折叠辅助；保留类型与选择器签名 | 修改（净删 ~1200 行） |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | 折叠位改走会话持有的投影核句柄（一页一帧） | 修改 |

### WP3 · 流式（切分 + 预算引擎退役）

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-compute/src/streaming/{split,budget}.rs` | 切分（JS 正则/trim/\s 字符集精确复刻、UTF-16 量纲）+ `RevealEngine`（D1 递减摊分、D2 UTF-16 计量不劈字素、400ms 追赶窗口、镜像单写者） | 新增 |
| `src/renderers/solid-workbench/chat/streamingMarkdownSplit.ts` | 全文件删除 | 删除 |
| `src/renderers/solid-workbench/streamingDisplayScheduler.ts` | 预算数学与镜像 → wasm；编排（rAF、flush、终态合并、判据 A/C、诊断环形缓冲）留 JS | 修改（瘦身） |
| `src/infrastructure/compute/streamingCompute.ts` | 装载薄层 | 新增 |

### WP4 · markdown 与高亮

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-markdown/**` | comrak（关默认特性）+ syntect(`regex-fancy`/`yaml-load`)；vendored tmLanguage 语法 14 份 + github `pl-*` 类名主题表（由 `gen/generate-assets.mjs` 从 starry-night 机械化导出）；`tm_language`/`theme`/`highlight`/`parser`/`model`/`wasm_exit`；`parity/` 差分工具与快照 | 新增 |
| `src/renderers/solid-workbench/chat/markdownRenderModel.ts` | unified/remark 管线 → wasm `parseMarkdown`；graft/LRU/settled 缓存保留 | 修改 |
| `src/components/chat/codeHighlight.ts` | starry-night/oniguruma 引擎 → wasm `highlightBlock`（整块进、行数组出） | 修改 |
| `src/infrastructure/compute/markdownCompute.ts` | 装载薄层 | 新增 |

### 门禁与基准

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| `scripts/build-wasm.mjs` | 扩成多目标（`pylon-compute` + `pylon-markdown`），`--only=<name>`；哈希戳覆盖 crate 源码与资产 | 修改 |
| `scripts/check-bundle-size.mjs` | wasm 产物独立记账；预算按实产物重定标 200,000 → 1,450,000（gzip） | 修改 |
| `scripts/bench-compute-boundary.mts` | 边界喂法基准（场景 A/B/C），按尺度预热 + 中位数 | 新增 |
| `.github/workflows/ci.yml` | 5 个 job 补 wasm 工具链；`build` 自带 wasm 前置 | 修改 |
| `package.json` / `tsconfig.json` / `eslint.config.js` / `vitest.config.ts` | wasm 构建步骤、生成目录排除、globalSetup | 修改 |

## 方案要点

1. **边界纪律的落地**（用户 2026-09-21 裁决，已钉进 spec）：批量入口只有 `append(batch)`，
   帧内事件类型走词表 u32 索引、字符串只留内容本体与预计算 ownerKey，热路径不吃
   serde_json；高亮整块进/整块（行数组）出，markdown 只喂 split 后的不稳定尾块。
2. **保留文档形状换零改动**：WP2 退役保留 `WorkbenchDocument` 与全部选择器签名，25 个
   消费者一行未改；选择器是**文档读层**，按 ADR-0018 留在 JS，折叠进 wasm。
3. **删除实现后清理过时注释**（AGENTS.md §6.2）：`workbenchProjector.ts` 头注原自述
   「deep pure module：不读时钟、store、registry 或 IO」，实现搬走后已改写为指向 wasm。
4. **#205 索引的 Rust 对位物**（见下「施工中修掉的缺陷」）。
5. **缓存字段不进 wire**：`WorkbenchDocument` 是手写序列化，新增的 `timeline_cache` /
   `applied_event_id_set` 不参与 `to_value`，故 patch 与文档形状逐字节不变。

## 施工中修掉的缺陷（都不是「新功能」，是补回退/补洞）

| 缺陷 | 表现 | 修法 |
| --- | --- | --- |
| `session_surface.rs` 的 budget `type` 回退读错键 | 输入键 `budgetType` 与输出键 `type` 不同名，previous 回退读了输入键 ⇒ 部分更新丢字段 ⇒ `usageBudgetProjection` 红 | 按 TS 口径单独取（注释点明「同名成对的 `text_field` 不能复用」） |
| 过界计数长在便捷路径上 | 直接驱动 `appendBatch` 时读数恒为 0（基准首轮就撞上） | 计数移到边界包装层：计数是**边界**的属性 |
| **冷重放 Θ(N²)**（#205 未随之移植） | 10 万事件下基准**跑不完** | ① 文本流/tool 边界查询改「二分定位窗口 + 只在窗口内求值谓词」，与全表扫描逐字等价且无索引失效风险；② `applied_event_ids` 补成员位（TS 是 `Set`，移植成 `Vec` 后线性扫）；③ 覆盖区间改就地并入；④ 终态 fence 改增量缓存（前提在注释里核对过） |
| CI 首轮红（两个前端 job 30s 内失败） | `tar (child): Cannot connect to D: resolve failed`——`$RUNNER_TEMP` 是 `D:\a\_temp`，GNU tar 把 `D:` 当远端主机说明 | 改用 `mktemp -d` 的冒号无关 POSIX 路径；curl 加 `-f` |
| CI 三个 Rust job 漏装工具链 | `bun run build` 经 tsc 解析 `src/wasm/**`（不入库），干净检出 TS2307 | 三个 job 补 wasm32 target + wasm-pack + 缓存；`build` 自带 `build:wasm` |

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| parity 差分：TS 基线 vs WASM 全 corpus 一致 | **部分**：WP3 切分/引擎、WP2 投影（帧 v2、逐字段）、WP4 markdown 116/117、高亮 10/12 |
| 绿后 TS 实现退役，不存在长期双实现 | **部分**：WP2/WP3 已删；WP4 markdown 与高亮引擎已切流，`starryCore.ts` 按 issue 的回退期条款保留为 parity 驱动；WP2 的选择器按 ADR-0018 留在 JS（读层） |
| 既有行为测试全绿且未被修改/弱化 | **达成**：`bun run test` → 621 文件 / 4685 用例通过，0 失败。测试改动只有 import 换 wasm 出口与 `MarkdownContent` 一条匹配器口径（见「测试处置」） |
| 新增 Rust 单测覆盖 D1/D2、字素/UTF-16 计量（property）、切分不变量 | **达成**：`pylon-compute` 161 + `pylon-markdown` 32 + `pylon-canonical-types` 9，0 失败 |
| 门禁扩展：`check:frontend` 增 wasm 步骤；`check:bundle` 记账；`check:all` 全绿 | **达成（CI 侧部分）**：`check:frontend:static`、`frontend-test` 两 job 在 PR #222 上**已跑绿**（4m5s / 5m31s / 5m22s）；`check:bundle` 已记账并重定标。`check:all` 全绿**未取到**（见「未解问题 1」） |
| 性能证据（实机前后对比） | **未达成**：mock 基准已有数字（见 spec），实机（webview2-mcp）前后对比未做 |
| 浏览器预览模式回归 | **未达成**：WP1 期用探针验证过 wasm 产物接入；本轮改动后的 `bun run dev` + mock 路径未复验 |
| 文档同步（架构参考 / 模块维护地图 / dev-standards） | **部分**：模块维护地图与 dev-standards 已补；**架构参考的 WASM 一节未加**（见「未解问题 3」） |
| 开工按规范落地 spec + ADR + L.md | **达成**（WP1 轮） |

## mock 基准（数字决断，spec「mock 基准实测结果」有全表）

| 场景 | 结论 |
| --- | --- |
| A · 冷装载 1 万 | 页级 batch vs 逐事件：过界 11 vs 10001（**909×**），端到端 4.88 s vs 136.4 s（**27.95×**）⇒ **纪律 1 成立** |
| B · 突刺 400 | 1 vs 401 次过界，5.5 ms vs 127.4 ms（**23×**）⇒ 纪律 1 成立 |
| C · 物化 | 全量 `document()` 占冷装载 33%，且随规模**超线性**（每页一次 ⇒ Θ(N²/page)）⇒ **纪律 3 在投影侧尚未完全落实**，patch DTO 补切片是正路 |
| 未解释读差异 | 同为「1000/页 × 10 页」，末尾物化 vs 每页物化的**折叠**耗时差 7×（3254.6 / 451.4 ms），调用序列相同。已排除预热序；疑似大 JSON 字符串的堆/GC 压力，**未仪器化证实，照实挂账** |

## 测试处置

- 新增：Rust 202 例；TS 四个 parity 门禁（events 54 / projector 17 / streaming 48 / markdown+highlight 若干）+
  `src/infrastructure/compute/__tests__/projectorCompute.test.ts`（边界纪律门禁）
- 修改的既有测试（逐条）：
  1. `chat/__tests__/streamingMarkdownSplit.test.ts`：import 从被删的 TS 基线换成 wasm 出口；**断言逐条未动**
  2. `chat/__tests__/issue55.rowSetPurity.solid.test.tsx`：import 换 wasm 出口 + 一条过时注释；断言未动
  3. `chat/__tests__/MarkdownContent.solid.test.tsx`：一处匹配器由 `getByText(/const x = 1/)` 改为按 `.term-code-text` 行的 textContent 断言。原因：旧 starry 引擎在 vitest 里装载 oniguruma 失败、**实际走了纯文本回退**，wasm 后高亮在测试环境真实工作、代码行被拆成 `pl-*` span，testing-library 只看直接文本节点。断言意图（代码内容完整出现）不变
  4. `streamingComputeParity.test.ts` / `markdownComputeParity.test.ts`：TS 基线退役后，原「两侧差分」改为「计算核契约不变量」与「快照一致」；**断言逐条保留、未弱化**
- 未删除任何测试文件。

## 证据

- 提交：`dab7a8eb`（WP1）、`41c7e35f`（CI 修复）、`83182c3d`（WP2–WP4 移植 + parity）、
  `599197ee`（构建/预算/clippy）、`76cbc819`（切流并删除旧实现）、`7e743392`（Θ(N²) 修复 + 基准）
- 测试：
  - `cargo test -p pylon-compute -p pylon-markdown -p pylon-canonical-types --lib`
    → `161 passed` / `32 passed` / `9 passed`，0 failed
  - `bun run test` → `Test Files 621 passed (621)`、`Tests 4685 passed | 1 todo`，0 failed
  - `bunx tsc -b` exit 0；`bunx eslint src/` 0 error
  - `cargo fmt --all --check` 通过；`cargo clippy -p pylon-compute --lib --tests` 0 warning
  - `bun run check:docs` exit 0；`bun run check:bundle` 通过
  - CI（PR #222）`前端静态门禁` pass 4m5s、`前端测试 1/2` pass 5m31s、`前端测试 2/2` pass 5m22s、
    `Rust clippy 基线门禁` pass 4m36s
- mock 基准：`bun scripts/bench-compute-boundary.mts --quick`（数字见上表与 spec）
- wasm 产物：`pylon-compute` 818,629 B raw / 296,113 B gzip；`pylon-markdown` 2,873,112 B raw / 904,589 B gzip

## 与 spec 的偏差

1. **WP4 的 crate 位置改了**：spec 原写仓根 `wasm-markdown/`（不在 `src-tauri` workspace）。实做落
   `src-tauri/pylon-markdown`——理由与 WP1 相同：另起 workspace 会被 `cargo test --workspace --lib`
   与 `cargo fmt --all` 漏掉（#106 P0 关掉的测试黑洞）。WP1 的「未解问题 3」由此结案。
2. **`starryCore.ts` 未删**：issue 的回退期条款允许保留一个发布周期，且它现在是高亮 parity 门禁的
   TS 侧驱动（删了就没有对照物）。**这是「未删旧实现」的唯一例外，已在 PR 里点名。**
3. **场景 C 的对照数字未测**（高亮整块 vs 逐行、markdown 尾块 vs 全文）：纪律已按整块落地，
   但「若逐行会多差」的对照未测，保留为待补证据。
4. **实机（webview2-mcp）性能对比未做**：验收第 5 条要求实机前后对比，本轮只有 mock 数字。

## 未解问题

1. **`check:all` 全绿未取到**：本地 `check:rust` 的 `cargo test --workspace --lib` 需编译主 crate，
   而本机 G: 盘曾 100% 满（8 KB 可用；我已清 `target/debug/incremental` 腾出约 7 GB）。
   CI 侧 `rust-test` job 在 PR #222 上当时仍 pending。**需复跑补齐。**
2. **patch DTO 未切片**：物化只能走全量 `document()`，是 10 万规模跑不完的主因（见基准结论 2）。
   补切片后 `WorkbenchDocument` 的物化才可能真正增量化。
3. **`docs/说明书/Pylon-项目架构参考.md` 的 WASM 一节未加**：#217 也声明了该文件，本轮避开；
   需在其收工后补，或由仓库主指定归属。
4. **wasm 体积**：合计约 1.38 MB gzip（其中 pylon-markdown 904 KB，主要是 vendored 语法）。
   已按实产物重定标 `check:bundle` 预算，但**降体积的正路是按语言惰性取语法**，需另立项。
5. **高亮 2 条剩余差异**（js 的 `\G` 依赖链、yaml 的 1 个 token）与 **markdown 脚注 1 条**：
   引擎级/结构级差异，已在 `parity-report.json` 逐条列出并过审，补法见报告。
6. **基准里那处 7× 折叠差异未解释**（见上表末行）——需仪器化复查，不应带着它进发布周期。

## 并行交集

- #217（ADR-0017）在本轮开工前半段与 #220 并行施工于同一工作树；其改动已自行提交
  （`22b57d0e`、`d6806da7`、`516954ee`），**我全程未触碰其文件域**。
- 本轮碰过的共享文件（供其他贡献者避让）：`AGENTS.md`（**未提交**——其中的 §6.2 注释规范
  是他人所加，我只按它执行）、`src-tauri/Cargo.toml`/`Cargo.lock`（新增两个 crate）、
  `package.json`、`tsconfig.json`、`eslint.config.js`、`vitest.config.ts`、
  `.github/workflows/ci.yml`、`scripts/audit-maintenance.mts`（注册两个新 crate 模块）、
  `docs/说明书/Pylon-模块维护地图.md`、`.agents/dev-standards.md`。
- 另有一段环境事故：施工中途 G: 盘写满，两个并行 agent 各自被阻塞过；我清理了自己在
  `/tmp` 的产物（约 400 MB）与 `target/debug/incremental`（6.7 GB，纯增量编译缓存，
  删后 cargo 自行重建）。**未删除任何用户的 target 内容与非本任务的临时文件。**

---

## 收口轮（2026-09-21，用户批准「Node 那半移出产品源码」后追加）

### 改动

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| `src/infrastructure/compute/wasmRuntime.ts` | 环境无关的装载门：浏览器走 glue 的 fetch；测试宿主预初始化后以 **glue 命名空间对象**为键登记 | 新增 |
| `scripts/wasmPreload.ts` | 测试侧读盘 + `initSync` 预初始化（`node:*` 只在这里），跨测试文件只缓存编译好的 `WebAssembly.Module` | 新增 |
| `vitest.setup.ts` | 每个测试文件求值前预初始化（`setupFiles` 语义） | 修改 |
| `src/infrastructure/compute/{pylonCompute,streamingCompute,markdownCompute,projectorCompute}.ts` | 去掉各自内联的 `node:*` / `isNodeRuntime` / `readWasmBytes`，改走装载门 | 修改 |
| `src-tauri/pylon-compute/src/projector/{content_part,workbench}.rs` | 增量下沉：只合并新产生的相邻对 + 文本就地 `push_str`；四处站点改用它，删掉已死的 `concat_parts` | 修改 |
| `scripts/bench-compute-boundary.mts` | 新增场景 D（护栏形态）与批大小规模曲线；**必须用 Node 跑**（见下） | 修改 |

### 修掉的缺陷

1. **产品源码里的 node 耦合**：前端门禁 job 在干净检出上 `TS2307: Cannot find module 'node:fs'`
   / `TS2591: Cannot find name 'process'`。根因是三个装载器把「从磁盘读 wasm」——一个
   **测试环境的关切**——写进了浏览器目标源码。现产品侧零 `node:*`
   （`src` 下仅剩既存的 `css04/typographyRegression.ts` 测试侧文件，它自带 `.d.ts` 垫片）。
2. **浏览器路径真 bug**：投影装载器在**导入期**调 `glue.projectorEventTypes()`。测试宿主因
   导入期 `initSync` 而没暴露它，浏览器里 glue 尚未初始化 ⇒ 导入即抛。改为懒建。
3. **投影折叠的 Θ(N²)**（护栏用例 20k delta：CI 5566ms → **461ms**，预算 2500ms）：
   ① 消息 content 用 `format!("{prev}{cur}")` 逐事件整份复制累计文本；② parts 数组用
   `concat_parts` + `coalesce_*` 每事件整份重建；③ 合并时逐对 `format!` 复制累计部件文本。
   修法见上表；等价性由 `incremental_sink_tests`（40 种子 × 6 种分批 × 两族规则 vs
   「整份重建」参考实现 + 累计文本逐字节 + 空批 no-op）守。

### 一处宿主假象（照实记录，避免后人据此改计算核）

单帧事件数 → `appendBatch` 耗时：Node 5k:29ms / 10k:202ms / 12k:262ms / 14k:283ms（线性）；
Bun 5k:34ms / 10k:56ms / **12k:11997ms / 14k:37808ms**（悬崖）。差异在 wasm 线性内存增长：
Bun 在堆约 270MB 处每次 `memory.grow` 都要搬运整块线性内存。Rust 单测 `project_batch(20000)`
= 0.37s，说明折叠本身线性。测试（vitest/Node）与生产（Chromium）都不在 Bun 上跑——
**基准脚本必须 `node scripts/bench-compute-boundary.mts`**。我此前用 `bun` 跑出的 60s+ 数字
是宿主假象，已在脚本注释里写明。

### 收口后证据（Node 宿主）

- `cargo test -p pylon-compute -p pylon-markdown -p pylon-canonical-types --lib`
  → 164 / 32 / 9 passed，0 failed（+1 ignored 诊断探针）
- `bun run test` → Test Files 621 passed / Tests 4685 passed | 1 todo，0 failed
- `bun run build` exit 0；`check:canonical-types` / `check:docs` / `check:deps` / `lint` /
  `check:bundle`（wasm gzip 1,211,696 / 预算 1,450,000）全通过
- `cargo fmt --all --check` 通过；`cargo clippy -p pylon-compute --lib --tests` 0 warning
- 基准（`node scripts/bench-compute-boundary.mts --quick`）：冷装载 10k 页级 batch
  **479.8ms** vs 逐事件 117,942ms（**245.8×**）；突刺 400 → 6.2ms vs 121.8ms（19.6×）；
  场景 D（20k 单帧）编码 103 + 折叠 606 + 物化 28 = **737ms**（护栏预算 2500ms）

### 仍未解（本轮新增两条）

7. **「不得慢于原生 TS」的同形态对照未做**：护栏用例注释记录迁移前约 0.2s、现 0.46s
   （约 2.3×）。注意那是**逐事件喂法**（纪律禁止的形态）下的对照；生产的页级喂法是
   10k/480ms。要做同形态对照，需要把迁移前的 TS 折叠 harness 从 git 历史里取出跑一遍
   ——属未完成项。
8. **大单帧的批大小敏感**：Node 下线性但堆会涨到约 280MB；生产按页（~1000）喂，
   落在曲线线性段，但「解码即折叠、不整页物化」仍是更稳的形态（未做）。

### 9. 【最重要】同 harness 对照：迁移后**比迁移前慢 11.28×**（未达成用户判据）

用户要求「不能出现用了 wasm 计算核还不如原生 TypeScript 的情况」。为此把迁移前的 TS 折叠
从 git 历史原样取出（`src/domains/workbench/__baselineOldProjector.ts`，冻结基线，不在任何
生产路径上），与迁移后的 wasm 折叠在**同一 harness、同一输入、同一 Node 宿主**上对照：

```
形状先验：TS {"timeline":20001,"messages":["user:3","reasoning:128890"]}
          wasm {"timeline":20001,"messages":["user:3","reasoning:128890"]}   ← 等量工作
同形态对照（20000 条 reasoning delta + 1 条 user，3 轮中位数）
  迁移前 TS 折叠 : 28ms
  迁移后 wasm 折叠: 315ms
  比值           : 11.28×（<1 表示 wasm 更快）
```

复现：`node scripts/bench-ts-vs-wasm.mts`

**成本落点不在边界，在 Rust 折叠本身**：Rust 单测探针 `project_batch(20000)` = 371ms
（对照同一探针的逐事件路径 358ms），而迁移前 TS 的**整条管线**只要 28ms。也就是说
「同一算法的 Rust 实现比 V8 上的 TS 实现慢约 13×」，再加上边界编组（帧编码 + `document()`
的 JSON 往返）才到 315ms。

机制（初判，未逐条仪器化证实）：Rust 侧用 `serde_json::Value` 建模整份文档——每个对象是
`BTreeMap`、每个数组是 `Vec`，逐事件的部件合并与消息更新都在这些树上分配；且每个批量入口
都 `document.clone()` 深拷整份文档 + `diff_patches` 建全 timeline 的 HashMap。迁移前的 TS
则是原地改普通对象/数组，V8 的对象模型与 rope 字符串让「追加文本」近乎 O(1)。

**这条推翻了 issue 的性能前提在本实现上成立**：就冷装载折叠而言，当前实现是回退而非收益。
收口方向（按收益排序，均需单独一轮）：

1. **热路径去 `Value`**：消息 content/parts、timeline 条目这些高频字段改定型结构体，
   只在边界进出时转 `Value`；`BTreeMap` 换有序 `Vec` + 二分。
2. **去掉每批量的深拷 + 全量 diff**：改为归约时增量记账（哪些 message/timeline 位置被触碰），
   patch 由记账产出，不再 `clone()` 整份文档。
3. **`document()` 的 JSON 往返**：物化改二进制/结构化编组，或让 patch 真正切片（未决问题 2）。

在 1–3 完成前，**不应把「wasm 计算核」当作已兑现的性能改进对外描述**；功能上它已切流并通过
parity 与行为测试，性能上尚未达到迁移前水平。**这是本轮最该被看见的数字。**
