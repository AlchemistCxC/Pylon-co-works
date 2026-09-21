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

### 10. CI 裁决（run 35564964030，head `f784dc98`）

| job | 结果 |
| --- | --- |
| 前端静态门禁（lint + tsc + build） | **pass** 5m14s（node 耦合消除后由红转绿） |
| Rust（fmt + 测试 + 构建） | pass 11m38s |
| Rust（clippy 基线门禁） | pass 4m49s |
| 前端测试 分片 2/2 | pass 6m27s |
| 前端测试 分片 1/2 | **fail** —— `#205 规模护栏：20,000 条 delta` `expected 2895.2868 to be less than 2500` |
| Rust（ACP shadow parity） | 本轮未取到 |

**分片 1 这条红是本 PR 最诚实的信号，不是 flake，也不该靠抬预算消掉**：护栏
（`src/__tests__/replay/projectionLinearization.test.ts`）的 2500ms 预算是**按迁移前的 TS 实现**
定的（注释记录迁移前本地约 0.2s，取 ~10× 余量），而本实现的同 harness 实测慢 11.28×
（见第 9 条）——**回退幅度正好吃掉那份余量**。护栏正在做它该做的事：报告迁移把投影折叠
做慢了。

因此本 PR 的状态是：**功能已切流、正确性有证据；性能未达迁移前水平，护栏仍红。**
按用户的「不得慢于原生 TypeScript」判据，本 PR 尚不满足完工条件；出路是把第 9 条的
三条优化做掉（去 `Value` / 去深拷全量 diff / 结构化编组），而不是调预算或删护栏。

### 11. 性能收口第一轮：把 11.28× 拆成「Rust 折叠」与「边界」两段（量到了，未收口）

按仓库主裁决（选 1：在本 PR 内继续收口）做的第一轮。**先把差距拆开量，再动手**——
用的是 `batch_fold_phase_probe`（`#[ignore]` 诊断探针）与 `bench-ts-vs-wasm`：

| 量 | 测值 | 说明 |
| --- | --- | --- |
| 迁移前 TS 折叠（同 harness） | **26–28 ms** | 整条管线，无进程边界 |
| 迁移后 wasm 折叠（同 harness） | **315–317 ms** | 11.28–12.0× |
| ↳ 其中 Rust `project_batch(20000)`，**release** | **130 ms** | 折叠本体 |
| ↳ 其中边界 + JS 侧（帧编码 ~70–100ms + `document()` JSON 往返 + `materializePage`） | **~185 ms** | 由 315 − 130 得出 |
| ↳ 同探针 **debug** profile | 318 ms | **别拿 debug 数当对照**：wasm 走 release |

所以差距是**两段各占一半量级**，不是单点：

1. **Rust 折叠 130ms = 6.5µs/事件**（release）。事件形状是 O(1) 工作量，6.5µs 说明按事件的
   分配仍然重：每事件 2 次 `event` 树克隆（`with_event` 的字段复制 + `timeline_entry` 的
   `data`）+ 约 8 次字符串分配 + `identity.to_value()` 建对象。这正是「① 去 `Value` 改定型
   结构体」要解决的东西——结构性改造，动的是 `WorkbenchDocument` 的数据模型、
   patch 产出与序列化三处。
2. **边界 ~185ms**：帧编码（把 20k 事件写成 5.3MB 紧凑列式）+ `document()` 的全量 JSON
   序列化 + JS 侧 `JSON.parse` + `materializePage` 结构共享重建。这是「③ 结构化编组 /
   真切片 patch」的靶子；`document()` 会在每次 `foldIntoProjector` 被调用（**含单事件折叠**），
   所以它同时是实时路径的常数开销。

**本轮实际落地的一处优化**：`reduce_workbench_event` 里
`SemanticEnvelope { event, ..envelope.clone() }` 会**连 `event` 一起克隆再覆盖**——逐事件
折叠里是一次纯浪费的整棵树复制。已由 `SemanticEnvelope::with_event`（只克隆其余字段）
取代。**诚实结论：这处在 JS 侧实测落在噪声内（317 vs 315ms），不是瓶颈**，但它是无谓
工作，保留清理。它**没有**改变 11× 的量级——差距要上面两条结构性改造才动得了。

**未收口**：目标是把 315ms 打到 28ms 以下，需要同时 ① 把 Rust 折叠从 130ms 压到 ~30ms
以下（要求每事件分配降一个数量级）与 ③ 把边界 185ms 压到接近 0（patch 真切片 + 结构化
编组，不再每次 `document()` 全量 JSON）。两者都超出「一处微调」的量级，各自需要一轮
独立改造 + parity 复验。护栏（2500ms 预算）在 CI 上仍会红，直到 ①+③ 落地。

### 12. 性能调查定案：385ms 的完整分段（release wasm，20k 事件）

用 `PylonProjector.foldPhases()`（新增的诊断出口：批量入口内 4 个时钟，把 decode / project /
patch 序列化分开）与 `bench-ts-vs-wasm.mts` 的边界分段，把迁移后的耗时逐段量清：

| 阶段 | ms | 占比 |
| --- | --- | --- |
| JS 帧编码 | 89 | 23% |
| wasm decode | 9 | 2% |
| **wasm project（折叠）** | **197** | **51%** |
| patch 序列化 | 6 | 2% |
| JS `JSON.parse(patch)` | 12 | 3% |
| wasm `document()` | 23 | 6% |
| JS `JSON.parse(doc)` | 14 | 4% |
| `materializePage` | ~54 | 14% |
| **迁移前 TS 全管线（同 harness）** | **25** | — |

**这条调查推翻了我上一轮的两个猜测**：① 「patch 是 3.5MB、序列化贵」——**错**，patch 3.48MB
但序列化只要 6ms；② 「边界（帧编码 + JSON 往返 + 物化）是大头」——只占 49%，而
**Rust 折叠本体就是 51%**，是最大单项。

再往折叠里切（native **release** 探针，20k 事件）：

| 分段 | ms | 说明 |
| --- | --- | --- |
| 全量 `project_batch` | 132 | wasm 侧 197（wasm 比 native release 慢约 1.5×） |
| 逐事件 `reduce_workbench_event` | 108 | 与批量几乎相同 ⇒ 没有批量级开销，纯按事件 |
| 仅「建 timeline 条目 + 入表」 | 36 | 含探针自建 envelope 的开销，条目本身约 15 |
| 含 `with_event` 信封复制 | 51 | ⇒ `with_event` 一项约 **+14.5ms** |
| 仅文本抽取 | 20 | 含探针开销 |

结论：折叠的时间**摊在按事件的分配上**，没有单点大头——`with_event` 的信封字段克隆（~15ms）、
`timeline_entry` 的事件树克隆、`identity.to_value()` 建 Map + `provider_identity_key` 哈希、
`text_from_parts` 建 String、`merge_reasoning_pair` 的 map 重建，各占几到二十毫秒。要把它从
197ms 压到 ~30ms 以下需要**热路径不再用 `serde_json::Value` 造树**（① 的结构性改造），
逐项微调凑不出来。

### 13. 本轮落地的两处真实优化

1. **JS 帧编码的字串池**：原来是 `const pool: number[]` + `for (const byte of bytes) pool.push(byte)`
   ——一帧 5MB 就是 500 万次 JS 数组 push，外加一次 `Uint8Array.from(pool)` 的再遍历。
   改为**分块 + 末尾一次 `set` 拼接**。实测编组 **119ms → 89ms**。
2. **`std::time::Instant` 在 wasm32 上会 panic**（本 crate panic=abort，表现为
   `RuntimeError: unreachable`）：阶段读数的时钟改为 `#[cfg(target_arch = "wasm32")] js_sys::Date::now()` /
   非 wasm 用 std。**这条平台约束值得后来者记住**：计算核里任何「读时钟」都必须走 `js_sys`
   或由 JS 传参（生产路径是后者，见 streaming 的 `tick(now)`）——与 dev-standards「计算核不读时钟」
   是同一条约束的两面。

### 14. 仍未达标（结论不变）

同 harness：**TS 25ms vs wasm 385ms（15.4×）**。本轮把 415→385（-7%），量级未动。
要真正收口，剩下的是**两件结构性改造**，各自需要一轮：

- **① 折叠去 `Value`**（197ms 的主目标）：消息 content/parts、timeline 条目改定型结构体，
  只在边界进出转 `Value`；`identity` 不建 Map、不哈希；`BTreeMap` 换有序 `Vec` + 二分。
  预期把 197 → 40ms 量级。
- **③ 边界**（其余 188ms）：帧编码 89（可用 `encodeInto` + 预分配池再压）、
  `document()`+parse+`materializePage` 约 91（patch 真切片后免掉全量 document）、
  patch+parse 18（patch 变薄后自然降）。

护栏（2500ms）在 CI 上仍会红到 ①+③ 落地。

### 15. 调查后的第三处优化：`provider_identity_key` 去掉按事件的 Map 构建

`provider_identity_key(&envelope.identity.to_value())` 在 message/reasoning 归约器里**逐事件**
被调用（3 处），而它为了取「第一个存在的身份字段」先建一整棵 JSON Map（BTreeMap + 最多 6 次
字符串克隆）。改为结构体直读（`provider_identity_key_of`），优先级与值版逐字一致。

**这次差点写出行为差异，是测试拦下来的**：我的第一版把 `Some("")` 当命中短路返回，而值版走
`string_value`，其判据是 `!js_trim(s).is_empty()`——空串与**仅空白**（含 U+FEFF）都算缺席。
`provider_identity_tests` 的 2^6 组合扫描（字段值交替「非空 / 空串 / 仅空白」）+ 三条显式
空白用例把这个差异抓了出来。这印证了一条做法：**这类微优化必须配等价性测试**，
否则 parity 基线退役后（TS 已删）错得无声。

实测：单项变化落在测量噪声内（该分段是单轮，本机 ±10%）。**三处优化都没有改变 15× 的量级**——
量级只能由 ①+③ 两轮结构性改造改变。

### 16. 第二轮优化（本轮全做）：热路径去克隆 + 帧编码槽表

| 优化 | 证据 |
| --- | --- |
| 帧编码的 18 个 (offset,len) 槽：原为每字段返回二元组数组（20k 事件 ≈ 100 万个短命数组），改为预分配 `Int32Array` 直写槽表 | 编组 **119 → 67ms** |
| `reduce_reasoning` 热路径对同一份 parts 做 **5 次整树克隆**（`parts` → `parts_items` → coalesce 重建 → `reasoning_parts.clone()` → `Value::Array(...)` 包装）：改为借用切片 + `text_from_slice` / `append_parts_slice_in_place` | 见下 |
| `identity.to_value().as_object().is_empty()` 逐事件建整棵 Map 只为判空 → `identity_is_present(&Identity)` 结构体直读 | 见下 |
| `with_event` 去掉「连 event 一起克隆再覆盖」的纯浪费 | 见下 |

四处都配了等价性测试，其中两处**测试真的拦住了行为差异**：
- `provider_identity_tests`：`Some("")` 与**仅空白**（`js_trim` 后为空，含 U+FEFF）都算缺席——
  我第一版短路返回空串，被 2^6 组合扫描抓出。
- `text_slice_equivalence_tests`：`text_from_slice(原始 parts)` 必须等于
  `text_from_parts(coalesce(parts))`（这条等价性是「省掉 coalesce 与整树克隆」的前提），
  以及切片版与值版下沉等价——60 种子随机部件序列（含 unknown+summary、缺 text、language 有无、空串、空数组）。
- 另有一次真实拼错：改槽序时多写了一个槽（每事件 19 而非 18），被 parity 门禁
  （35 用例）当场判红。

**实测（同一 harness，3 轮中位数）**：迁移前后对比 **~280ms vs ~28ms ≈ 10×**；
本轮五处优化把它从 **315ms 压到 ~280ms（-11%）**，**量级未变**。

### 17. 【测量方法学，重要】重复大批量折叠会退化——多轮采样会污染结论

本轮把分段改成「5 轮中位数」后出现了荒唐数字：`project` 的中位数变成 **2718ms**（首轮约 200ms），
`foldIntoProjector` 中位数 3849/4091ms。根因不是代码变慢，而是**在同一个进程里反复折叠大批量**会让
wasm 线性内存持续增长，而每次 `memory.grow` 的代价随堆大小上升（Bun 上更极端，见 §12 的宿主悬崖）。
即使把轮次降到 1，**分段仍然被它前面的折叠（形状先验那两次 20k）污染**（同一轮里 project 报 471ms）。

结论：**这份基准必须一进程一配置**。当前脚本的「同形态对照」段（每次新建投影核、3 轮中位数）是
唯一稳定可比的读数（5 次独立运行：315 / 306 / 282 / 274 / 282 ms），分段数字只能当量级参考。
把 `scripts/bench-ts-vs-wasm.mts` 改成 `--only=<段>` 一进程一段，是下次先要做的事。

---

## 18. 【调查定案】迁移当前在两种喂法上都是净回退，根因唯一且可定位

测量方法：**一进程一配置**（`scripts/bench-probe.mts --case=...`）。理由见 §17——同进程重复大批量折叠
会被 wasm 堆增长污染，这是本轮调查最重要的方法学前置。

### 干净读数（Node 宿主，每 case 独立进程）

| case | N | 耗时 | 与 main 的 TS 比 |
| --- | --- | --- | --- |
| `cold-ts`（main 的 TS 折叠） | 20k | **28.4 ms** | 基准 |
| `cold-wasm` 单帧 | 20k | **405.5 ms** | **14.3×** |
| `cold-wasm` 1000/页（生产喂法） | 20k | **758.7 ms** | **26.7×** |
| `live-ts`（TS 逐事件） | 1k | **15.4 ms** | 基准 |
| `live-wasm`（逐事件） | 1k | **1383.2 ms** | **90×** |

两侧结果形状逐字节相同（`timeline 20001` / `messages ["user:3","reasoning:128890"]`），即等量工作。

### 消融（同进程内的定向 ablation，用于定位而非取绝对值）

| ablation | N | 耗时 | 得到 |
| --- | --- | --- | --- |
| `doc-loop`：先折完 N 条，再循环「`document()` + `JSON.parse`」N 次 | 1k | **1512 ms** | live 路径总 1383ms ≈ 全在这里 ⇒ **live 的成本 ≈ 每事件一次全量文档读** |
| `encode-loop`：只做「帧编码 + `appendBatch`」，不读文档 | 1k | **348 ms** | ⇒ 每事件仍有 **0.35 ms 固定底噪**（纯过界+批量开销） |

native release 的受控消融（20k，段 0 = 只建信封 21.0ms 为 harness 基线）：

| 段 | 累计 ms | 差值 = 该部分 |
| --- | --- | --- |
| 1 + `timeline_entry` + `insert_by_sequence` | 36.8 | **15.8** |
| 2 + `reduce_semantic_event` | 70.9 | **24.0**（已扣其中的 `with_event`） |
| 3 + `refresh_orphans` | 71.1 | **0.2**（可忽略） |
| 4 只 `with_event`（信封复制） | 31.1 | **10.1** |
| 5 只 `reduce_reasoning` 本体 | 49.5 | **≈18.4** |
| 完整 `project_batch(20000)` | 97.0 | 上面各项只解释 ~50 ⇒ **其余 ~47ms（48%）在两个每批量动作** |

### 根因（唯一）

`project_batch` 每次调用都：

1. `let before = document.clone()` —— **整份文档深拷**（全部消息含累计文本与 parts 树、全部 timeline 条目）；
2. 逐事件折叠；
3. `diff_patches(&before, document)` —— 对**全部** messages 做整对象 `!=` 比较、为**全部**
   before.timeline 建 `&str` HashMap、再对**全部** after.timeline 逐条查表 + 深比较
   `TimelineEntry`（内含 `data: Value` 树）、并把**全部新增条目** `to_value()` 收进 patch。

⇒ **每次调用的成本是 Θ(文档规模)，与本次喂了多少事件无关。** 冷装载单帧调用 1 次
（可接受），但 **live 路径是每事件一次调用** ⇒ Θ(N)/事件 ⇒ **整体 Θ(N²)**，并且每事件
还附带一次全量 `document()` 的 JSON 往返（TS 侧 `reduceWorkbenchFold` → `foldIntoProjector`
里那句 `document()`）。这解释了 `0.35 ms/事件` 的底噪，也解释了 §12 那张表里那 3.5MB patch
（空 `before` 时全部 20k 条目都是 upsert）——而消费方同时又在读全量 `document()`，
**这份 patch 与那份文档是同一批信息的两次传输**。

**这正是 issue 要消灭的复杂度，被重新引入了边界层。** main 的 TS 两条路都慢在别处：
冷装载它没有边界（同进程建对象，28ms），live 它每事件克隆文档（V8 浅克隆很快，15ms/1k）。
我们的实现把「每事件一次全量序列化 + 重建」叠加在「每批量一次全文档深拷 + 全量 diff」之上。

### 修法（已定位到函数，各自有界）

**③-a（Rust，收益最大）**：`project_batch` 不再 clone+diff，改为**折叠过程中增量记账**
- 记「被触碰的 message 下标 + 其变更前的值」（用于回滚与 upsert，规模 = 本页而非全文档；
  现状的 `document = before` 整份回滚也可改为按记账回放）；
- 记「本页新增/变更的 timeline 条目下标」（timeline 只增不减，新增即尾部区间）；
- `applied_event_ids_appended`、`applied_ranges` 已有现成增量口径。
⇒ 每批量成本从 Θ(文档) 降到 Θ(本页)，live 底噪 0.35ms/事件应降到 ~0.02ms 量级。

**③-b（Rust + TS）**：patch 补齐切片（activities / diagnostics / plan / goal / lifecycle /
systemErrors / assist / interactions / extensions），低频字段可以「脏则整面重发」；
TS 侧 `foldIntoProjector` 改为**把 patch 应用到上一份 JS 文档**，热路径不再调用 `document()`
（`document()` 只留给冷刷新与 parity）。这一条同时消掉 live 的每事件全量 JSON 往返，
以及分页冷装载的 26.7×（现在每页都重传全量文档）。

**①（折叠去 `Value`）**：native 侧 97ms 里按事件部分约 50ms（`timeline_entry` 15.8 +
`with_event` 10.1 + `reduce_*` 24），去 Value 化是把它压到 20~30ms 的路。加上 wasm 侧
相对 native 还有约 2× 的分配器差距（dlmalloc），两者都要动。

**顺序建议**：先 ③-a（一行函数级改造、收益最大、不动 wire 形状）→ 再 ③-b（补 patch 切片，
动 wire DTO，要重跑 parity）→ 最后 ①。

### 给基准脚手架的硬要求（本轮踩出来的）

1. **一进程一配置**。同进程重复大批量折叠会让 wasm 堆持续增长、`memory.grow` 代价随堆上升，
   多轮中位数会被污染到 10× 以上（实测 project 中位数 2718ms vs 首轮 ~200ms）。
2. 两侧必须做**等量工作先验**（本仓用 document 的形状指纹逐字节比对），否则比值无意义。
3. 预热要**按测量尺度**做（200 事件的预热不足以让 1 万规模定型，曾虚高 6×）。
4. 分段要分「wasm 内部」与「JS 侧」——本轮为此加了 `PylonProjector.foldPhases()` 诊断出口
   （批量入口内 4 个时钟，把 decode/project/patch 序列化分开）。
5. 逐事件 live 路径要单独一类，别和冷装载混：两者成本结构不同（前者每事件一次全量读）。

### 19. main 的 TS 计算实现清单 —— 各退到哪个提交、怎么取回（给基准脚手架）

退役提交是 **`76cbc819`**（"切流并删除旧实现"），它的父提交 **`76cbc819^`** 就是「实现已进 Rust、
TS 仍是唯一实现」的最后状态——**要拿 main 的 TS 基线，一律从这个提交取**。

| 计算面 | 文件 | 退役形态 | 取回方式 |
| --- | --- | --- | --- |
| WP2 投影折叠 | `src/domains/workbench/workbenchProjector.ts`（1626 行） | 改写为 410 行薄壳 | **已取回**：`git show 76cbc819^:src/domains/workbench/workbenchProjector.ts` → 现落 `src/domains/workbench/__baselineOldProjector.ts`（冻结基线，文件头注明不在生产路径、差距收口后与对照脚本一并删） |
| WP3 流式切分 | `src/renderers/solid-workbench/chat/streamingMarkdownSplit.ts` | **整文件删除** | `git show 76cbc819^:src/renderers/solid-workbench/chat/streamingMarkdownSplit.ts` |
| WP3 揭示预算引擎 | `src/renderers/solid-workbench/streamingDisplayScheduler.ts`（783 行） | 改写（预算数学与镜像搬走，编排留下） | `git show 76cbc819^:...` —— 该文件的**旧版整份**即基线 |
| WP4 markdown 解析 | `src/renderers/solid-workbench/chat/markdownRenderModel.ts`（548 行） | 解析管线换 wasm | `git show 76cbc819^:...`（unified/remark 管线，依赖仍在 package.json） |
| WP4 代码高亮 | `src/components/chat/codeHighlight.ts` | 引擎换 wasm | `git show 76cbc819^:...`；其 TS 基线驱动 `src/components/chat/starryCore.ts` **仍在树里**（按 issue 回退期条款保留），可直接 import |
| 事件层纯规则 | `src/domains/events/*.ts`、`src/infrastructure/events/canonicalEventBatch.ts` | **未删**（Rust 侧是并行实现） | 直接 import 现文件即可 |

**取回时的注意**：这些文件之间的相对 import 仍成立（都还在树里），所以把旧文件放到**同目录**
（像我给投影做的那样加 `__baseline` 前缀）即可用；不要改它们的内容（价值就在于逐字节等于 main）。

**还差的对照面**（本轮未做，脚手架可一并覆盖）：
- WP3：`splitStreamingMarkdownBlocks` / `splitOpenCodeFenceTail`（纯函数，对照容易）
  与揭示预算引擎（`streamingDisplayScheduler` 的 `revealBudget`/`interpolateSnapshot` 族，
  需要按旧文件的测试夹具驱动）。
- WP4：`parseMarkdown`（unified+remark-gfm → 渲染模型）与 `highlightBlock`（starry-night
  整块高亮）——两者都有现成的 parity 语料（`src-tauri/pylon-markdown/parity/corpus.json`，
  117 markdown + 12 高亮），可直接复用做性能语料。
- 边界本身（帧编码/解码、patch、`document()`）**没有 TS 对位**，它是迁移新增的，
  只能给绝对值与「每次调用 / 每事件的过界成本」。

---

## 20. ③-b 落地：patch 自足 + 热路径不再读全量文档（live 90× → 3.6×）

调查（§18）指出 live 的成本几乎全在「每事件一次全量 `document()` 读」；本轮把那条路拆掉。

### 改动

**Rust 侧**
1. `ChangeSet` 增加**低频切片脏位**（`Slice` 枚举 9 项）：activities / interactions / extensions /
   assist / diagnostics / plan / goal / lifecycle / systemErrors。这些切片整面重发即可，
   但**必须在脏时随 patch 下发**——因为消费方不再靠 `document()` 拿全量兜底，漏标 = 读到陈旧切片。
   12 处写点逐个标记（`refresh_orphans` 只在真正改写 `orphan` 时标，避免每事件标记整表）。
2. `WorkbenchPatch` 增加：`timelineLength` / `messageLength`（供消费方精确合并）、
   9 个 `Option<...>` 切片（脏才带），并把 `timeline_upserts` 改成**带下标**的
   `TimelinePatch { index, entry }`（与 `MessagePatch` 对称）——合并必须知道下标。
3. `diff_patches`（测试用参考实现）同步产出新字段（切片按「与批前不同」判脏），
   于是 §19 的等价性断言自然覆盖到切片：**记账产出必须覆盖参考产出**。

**TS 侧**
4. `applyPatch`：把 patch 应用到**上一份文档**上，产出新文档（新增 `mergeByIndex` 做下标精确合并，
   一个循环同时处理追加/替换/中插三种情形）。
5. `foldIntoProjector` 只在「上一份文档就是本核产出」时走 `applyPatch`；否则回退到
   **原来的全量物化**（`materializePage`，从 git 取回）——两条路径的收口语义一致。

### 实测（一进程一配置）

| case | ③-a 后 | **③-b 后** | TS | 比值 |
| --- | --- | --- | --- | --- |
| cold 20k 1000/页 | 620.4ms | **219.8ms** | 27.2ms | **8.1×**（原 26.7×） |
| live 2k 逐事件 | 3713ms | **189.5ms** | 52.7ms | **3.6×**（原 90×） |

### 两条被测试拦下的契约（都不是新契约，是既有语义）

1. **文档 JSON 的键序**：`appliedRanges.test.ts` 有一条「分两次折 == 一次折」的**逐字节**
   JSON 比较；文档的 JSON 形状此前由 wasm 产出（serde_json 的 Map 是 BTreeMap ⇒ 字典序），
   而我在 `applyPatch` 里按可读顺序写字面量 ⇒ 键序不同 ⇒ 该断言红。
   处理：`applyPatch` 的字面量**刻意取字典序**并注明原因（不要为好看调整字段顺序）。
2. **切片引用必须稳定**：`mountSolidWorkbench` 的「payload/appearance 全等时跳过 surface.update」
   浅比较门要求「未触碰的切片沿用上一份引用，且全切片引用相等时恒等返回上一份对象」。
   我最初的 `coldMaterialize` 每次都 spread 一个新对象 ⇒ mount 后多出一次 update ⇒
   追加 interaction 那一步的断言红。处理：**恢复原来的全量物化作为兜底路径**，
   它天然具备这套引用复用语义；`applyPatch` 也做同样的恒等收口。
   → 这条也解释了为什么「不读全量文档」不能简单替换全部路径：**渲染门的浅比较依赖那条
   路径的引用复用行为**，两者必须共存（本核产出走 patch，其他走全量物化）。

### 一处必须先排掉的坑（否则会静默出错）

`resolveEntry` 对**外置文档**（宿主手工构造、池里认不出）会起一个**空核**并把该文档当 `base`
传进来。此时把 patch 应用到 `previous` 上会把「外置内容」与「空核的增量」混成一份既不是 A
也不是 B 的文档。因此热路径用 `state.lastDocument === previous` 把「本核自己的产出」与
「外借的文档」分开——前者才允许 applyPatch。

### 测试处置（本轮改了 1 处既有断言）

`src/infrastructure/compute/__tests__/projectorCompute.test.ts` 的**过界计数**断言：
原为 `3*2 + 1*2 = 8`（假设每次折叠都读全量），现为 `1*2 + 1*2 + 2*1 = 6`——
冷启动/外置文档 2 次、本核产出 1 次。这是**契约变更**（热路径不再读全量），
不是弱化：注释里写清了口径。其余断言未动。

---

## 21. 用户脚手架（`scripts/compute-parity/`）首轮对照：16 → 9 mismatch，并修掉一个真缺陷

仓库主为本次收口写了 TS↔wasm 对照脚手架（`scripts/compute-parity/`：harness + 8 套件 +
冻结基线 + 覆盖门）。首轮判词：**175 项：ok 157 / known-diff 2 / mismatch 16**。

### 脚手架侧三处阻塞（我已修，供作者确认）

1. `scripts/compute-parity/suites/eventsSuite.ts`：`stableJson` 从 `../index.ts` 引入，而它
   在 `../harness.ts` —— vitest 的解析宽松所以只在非 vitest 入口暴露：**bun/node 直接
   `SyntaxError`**（`compute-parity-bench.mts` 是 node 入口，等于性能对照跑不起来）。
2. `scripts/compute-parity/suites/projectorSuite.ts` 的 `range-scale` 用例 `build()` 多包一层
   （`[[[ranges,1,1]]]`）⇒ 解构出的 `ranges` 是数字，`oldCoverageMerge` 抛
   `1 is not iterable`，整轮对照中断。
3. `scripts/compute-parity.test.mts` 缺 `@vitest-environment jsdom`：markdown 的 TS 基线
   （旧 unified 管线）经 `decode-named-character-reference` 的 dom 变体读 `document`，
   在 node 环境下 `ReferenceError: document is not defined`。根 `vitest.config.ts` 按该注释分环境。

### 计算核侧：一个**真缺陷**（脚手架抓到的，仓库内门禁当时是瞎的）

`parseMarkdown` 用 `serde_wasm_bindgen::to_value` 直转，而 `properties` 是 `BTreeMap`——
serde_wasm_bindgen 默认把它编成 JS **`Map`**。后果：`JSON.stringify(node.properties)` 得到 `{}`、
按对象读 `properties.href` 得到 `undefined`，即**链接丢 href、代码块丢 language class、
任务列表丢 checked**。产品路径只因为 TS 侧有 `normalizeNode` 把 Map 归一成对象才没炸，
而仓库内的 markdown parity 门禁两侧都看不到「边界怎么编组」（Rust 快照走 serde_json = 纯对象；
现场解析走产品路径 = 已被归一），所以**这道门禁对它是隐形的**。

修法两处：
- `wasm_exit.rs`：`parseMarkdown` 改 `Serializer::new().serialize_maps_as_objects(true)`
  （`PropValue` 无 null，不存在 `to_boundary_json` 那条 null 保真顾虑）；
- `markdownComputeParity.test.ts` 补一组**边界编组**断言：直接取 `parseMarkdown` 的原始出口，
  断言 `properties` 原型是 `Object.prototype`、链接/代码/任务列表带对关键键
  （Map 会被 stringify 抹成 `{}`，所以「序列化后非空」等价于「真是普通对象且有键」）。

### 计算核侧：一处 `received` 误报

`projectorParseContentPart`：输入 `{ kind: 'text', text: 123 }` 时 TS 报 `received: "number"`，
Rust 报 `"undefined"`——5 处校验写成「布尔判定 + 恒报 undefined」，把「类型不对」误报成「缺席」。
新增 `issue_at(record, key, ...)`：键存在按实际值报、缺席才报 undefined（与 TS
`issue(..., value[key])` 同义）。`parse_unknown` 的 originalType/summary/raw/truncated 四处同修。

### 结果与剩余

**175 项：ok 157 → 164 / mismatch 16 → 9**（known-diff 仍是 2：脚注、高亮 js-sample——按预期）。

剩余 9 条我分了三类（**其中 7 条看起来是脚手架侧的形状/归一缺口，需作者定契约**）：

| 类 | case | 现象 | 我的判断 |
| --- | --- | --- | --- |
| 形状归一缺口 | `mergeAdjacentDeltaChunks` ×3 | TS 全返 `{index,kind:'event'}`；wasm 返 `{index,kind:'batchRow',row}` | TS 基线返的是旧内部形状、wasm 返的是 wire 形状；套件该在 `normalize` 里对齐（harness 已有该钩子） |
| 形状归一缺口 | `expandTurnUnitRows` ×1 | TS `[{index,kind}]` vs wasm `[{event}]` | 同上 |
| 形状归一缺口 | `projectorCoalesce*Parts` ×2 | TS 返裸 parts 数组；wasm 返 `{changed,parts}` | Rust 出口带诊断位；`normalize` 取 `.parts` 即可 |
| 需作者判 | `effectiveCanonicalProjectionEvents` ×1 | TS `[{index:0..5,sequence:1}]`（全部同序）vs wasm 过滤后的真实序列 | TS 基线像是枚举全部输入；要确认哪边是旧 TS 的真实语义 |
| **计算核侧（待查）** | `projectWorkbench(paged) / idempotent-refold` ×1 | 文档在 @5274 分歧：TS 该位是 `message.delta`(user) 条目，wasm 是 `reasoning.delta` 条目 | **这条是我该继续查的**：分页重折的终态与旧 TS legacy 基线不一致 |
| 表征差异（应列 known-diff） | `splitStreamingMarkdown(prefix-scan) / growing-source` ×1 | 偏移 45 处 TS 给孤立代理 `\ud83d`、wasm 给 U+FFFD | JS 字符串可表示孤立代理、Rust UTF-8 不可——spec/§3 已记录该表征差异；建议进 scaffold 的 known-diff 并注明原因 |

**注意**：`bun run test` 现在会因脚手架那 9 条 mismatch 而红（它是仓库主新加的门禁文件，
未由我提交）。我的改动本身在 `bun run test` 里除该文件外全绿。

### 本轮性能侧（③-a/③-b 之外的第三轮）

- `SemanticEnvelope.event` / `TimelineEntry.data` 改 **`Arc<Value>`**：信封与 timeline 条目共享
  同一棵事件树，逐事件的深拷变成引用计数。native `project_batch(20000)`：97 → **69.6ms**。
- `TimelineEntry` 手工 `Serialize`（键序按字典序，与 `to_value()` 的 BTreeMap 一致）+
  `TimelinePatch.entry` 持 `TimelineEntry`：**收批不再建 20k 个中间 JSON 树**，
  收批 29.5 → **4.3ms**；`project_batch` → **44.4ms**（本轮起点 130ms，−66%）。
  键序契约由 `timeline_entry_serialize_tests` 逐字节钉死（含小数 sequence）。

---

## 22. 脚手架门禁通过 + 全出口性能对照（首轮完整读数）

**门禁**（`bun run test scripts/compute-parity.test.mts`，2/2 passed）：
`parity 断言 175 项：ok 172 / known-diff 3 / mismatch 0`。3 条 known-diff 正是预期的那三条：
流式切分的孤立代理表征差异、markdown 脚注、高亮 js-sample。

**性能**（`bunx vite-node scripts/compute-parity-bench.mts`，scale=m，每侧 3 轮中位数，
175 case；`ratio = wasm/ts`，<1 表示 wasm 更快）：

| 域 | case 数 | 中位 ratio | 最好 | 最差 | 读法 |
| --- | --- | --- | --- | --- | --- |
| markdown-parse | 17 | **0.06×** | 0.03× | 0.11× | **wasm 快 17/17**，且是绝对量最大的一块 |
| streaming-budget | 9 | **0.81×** | 0.53× | 2.09× | 6 快 / 3 慢 |
| streaming-split | 89 | 1.43× | 0.34× | 3.00× | 绝大多数 case < 0.5ms，比值由每次调用的过界开销主导 |
| markdown-highlight | 10 | 1.85× | 0.50× | 8.21× | syntect vs starry-night，引擎级 |
| canonical | 6 | 4.38× | 1.14× | 5.43× | 绝对值 0.00–0.05ms，同上：纯过界开销 |
| projector | 18 | 5.36× | 1.60× | 16.00× | **端到端真实比值**（生产入口） |
| events | 26 | **12.44×** | 0.41× | **152.53×** | 见下：主要是诊断出口的 JSON 编组，不是计算 |

绝对耗时 ≥0.2ms 的 case 才是有效读数。其中：

**wasm 明显更快**
- `parseMarkdown doc-m`：86.90 → **9.34ms（0.11×）**；`doc-s` 6.66 → 0.57（0.09×）；
  各 xs 用例 0.03–0.11×（comrak 对 unified JS 管线的结构性优势）
- `splitStreamingMarkdown blocks-m` 0.34×、`splitStreamingMarkdownBlocks blocks-m` 0.76×、
  `findLastStableBlockBoundary blocks-m` 0.38×
- `StreamingRevealEngine`：smooth-m 0.89×、burst-drain 0.67×、options 族 0.53–0.58×

**wasm 明显更慢**
- `projectWorkbench(fold) mixed-m`：42.75 → **222ms（5.20×）**；`delta-m` 2.64 → 20.28（7.67×）；
  `paged-replay-m` 4.21 → 27.21（6.46×）——**这是生产入口的真实比值**，与我此前隔离测量的
  7.5×/9.7× 一致，主因是折叠的按事件分配（① 未做）+ 边界
- `mergeAdjacentDeltaChunks byte-cap-2002` 0.48 → 24.92（**51.73×**）、
  `normalizeRawEvent turn-batch-scale` 0.86 → 10.35（12.06×）、
  `canonicalBatchSpanOf batch-scale` 0.02 → 3.74（**152.53×**）、
  `projectCanonicalMessages conversations-scale` 0.18 → 3.34（19.04×）、
  `projectToolProjectionsFromBatch tools-scale` 0.03 → 1.47（42.62×）
  —— **注**：这些 pair 的 wasm 侧是「`JSON.stringify(整个语料)` 进、`JSON.parse` 出」的
  诊断出口，比值里含整份语料的编解码，**不是计算核本体**；生产路径不走这条（projector 走二进制帧）。
- `highlightBlock`：ts-sample 0.34 → 0.85（2.53×）、css-sample 0.13 → 0.50（3.75×）
- `StreamingRevealEngine astral-grapheme` 0.19 → 0.41（2.09×）——字素/UTF-16 路径

**由此得到的下一步排序（按数字，不按直觉）**
1. **events 层出口去 JSON 编组**：把 `normalizeRawEvent` / `mergeAdjacentDeltaChunks` /
   `canonicalBatchSpanOf` / `projectCanonicalMessages` / `projectToolProjectionsFromBatch`
   这类出口从「JSON 字符串进/出」改成与 projector 同款的**二进制/批量**形态——那几个
   12–152× 的比值主要是编组，改完应回到同一量级。
2. **① 折叠去 `Value`**：projector 5–8× 的端到端比值（生产真实路径）主要在这里。
3. **高亮** 1.4–3.8×：syntect vs starry-night 的引擎差异，量级小（<1ms），可后置。

---

## 23. 性能收口第三轮：投影折叠的 Θ(N²) 扫描点（mixed-m 5.8× → 1.2×）

用户 2026-09-21 裁决「跑一轮 benchmark + 全面调查剩余性能较差项」。先复跑量门槛，
再把每个红数**拆到函数**，最后按拆出来的账动手。

### 复跑（baseline，未改代码）

`bunx vite-node scripts/compute-parity-bench.mts`（scale=m，每侧 3 轮中位数，175 case）：
`parity 断言 175 项：ok 172 / known-diff 3 / mismatch 0`。分域摘要与 §22 同形；
projector 域 1 快 / 17 慢，`mixed-m` 42.70 → 223ms（5.22×）是其中绝对值最大的一行。

### 调查：三段拆分（每层都用可复现的探针，不靠印象）

**① 先把「宿主帧编码」从「wasm 计算」里摘出来。** 新写一次性探针
（`scripts/bench-decompose.mts`，已删）对 events 域的批出口分别量
「只编码 / 编码+wasm / 预编码后的 wasm」：

| pair · case | 只编码 | 预编码后 wasm | ts | 说明 |
| --- | --- | --- | --- | --- |
| `mergeAdjacentDeltaChunks · byte-cap-2002` | **15.23ms** | 6.21ms | 0.51ms | 编码占 71% |
| `canonicalBatchSpanOf · batch-scale` | **3.62ms** | 0.17ms | 0.03ms | 编码 ≈ 全部 |
| `projectCanonicalMessages · conversations-scale` | 0.91ms | 1.64ms | 0.09ms | 编码是少数 |
| `projectToolProjectionsFromBatch · tools-scale` | 1.07ms | 0.33ms | 0.03ms | 编码占多数 |

⇒ **脚手架 events 套件的 wasm 侧把 `frameOf(...)`（JS 侧 PYPB 编码）算进了计时**，
那几个 12–152× 里有一截是**宿主编码**而非计算核。**并且 events 层根本没切流**：
`canonicalEventSink.ts` / `canonicalEventBatch.ts` 仍 import TS 实现
（`src/infrastructure/compute/` 里也没有 events 桥），所以这些比值量的是**尚未接线**
的路径。这条要如实写进结论，不能当成「计算核慢 152×」对外描述。

**② 投影端到端按相位拆。** 用 `foldPhases()` 诊断出口（decode / project / patchJson）
加 JS 侧分段：

| case | N | 宿主编码 | appendBatch（核内 project） | document 物化 | e2e | ts | 比值 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `delta-m` | 2001 | 7.85ms | 7.73（**project 仅 2ms**） | 2.42 | 19.49 | 3.34 | 5.84× |
| `mixed-m` | 2251 | 7.88ms | 213.08（**project 225ms**） | 4.01 | 233.21 | 39.98 | 5.83× |

⇒ delta 与 mixed 的成本结构完全不同：delta 是**边界主导**（编码 7.9 + patch 串 400KiB
的过界+parse），mixed 是**折叠主导**（2251 事件 225ms = 100µs/事件）。

**③ 折叠里逐事件类型隔离（native release 探针，`mixed_journal_probe`，已删）。**
复刻脚手架 `mixedJournal` 的逐事件形状，2000 条单类各测一遍：

| 单类（2000 条） | 耗时 | µs/事件 | 结果形状 |
| --- | --- | --- | --- |
| `diagnostic.notice` | **2246.7ms** | **1123** | messages 0 / timeline 2000 |
| `tool.started`（独立 id） | 291.2ms | 145.6 | activities 2000 |
| `interaction.requested`（独立 id） | 32.6ms | 16.3 | interactions 2000 |
| `message.delta`（独立 id） | 15.6ms | 7.8 | messages 2000 |
| `reasoning.delta` | 3.8ms | 1.9 | messages 1 |
| `session.status-updated` | 2.6ms | 1.3 | — |
| `message.completed` | 2.1ms | 1.0 | — |

mixed 全量随规模翻倍、每事件成本翻倍（50/100/200/400 blocks → 35/58/112/230 µs/事件）
⇒ **确认 Θ(N²)**。往函数里挂临时计数器（原子计数「全表扫描步数」，跑完已删）读出
mixed-400 的 6.65M 步里：`update_timeline` 全表扫 ≈1.4M 步、`settle_superseded` ≈0.85M 步、
`refresh_orphans` 活动数×事件数 ≈4.0M 步。

### 定位到的四个根因（都在 Rust 侧，且都不是「新设计」）

1. **`reduce_diagnostic` 整份 `document.clone()`**（`workbench.rs`）。TS 基线写的是
   `{ ...document, systemErrors: [...] }`——**浅展开**；移植成 Rust 后写成深拷再
   `*document = with_error` 搬回，于是**每个 diagnostic 事件付一次 Θ(文档) 深拷**
   （全部 message/timeline/Value 树）。这是 §18 从 `project_batch` 里摘掉的那个模式，
   在归约器里活了下来。⇒ 就地改写（调用方持 `&mut`，无回滚需求）。
2. **`refresh_orphans` 逐事件重建 id 集合**（每个 id 一次 `String` 分配），且**逐事件全表
   遍历 activities**。TS 的 `refreshOrphans(document, providedIds)` 本就有 id 集合缓存
   （#205 的对位物），移植时漏了。⇒ 加 `ActivityIndex`（写版本戳 + id 集合 + id→下标表），
   版本未变整段跳过；顺带把「id 相同、kind 不同」的逐候选判定保留（不合并语义）。
3. **`update_timeline` 全表线性扫 `event_id`**：在 message/tool/diagnostic 的沉降路径上
   每次折叠都调，⇒ Θ(N²)。⇒ 加 `TimelineIndex`（eventId→下标）；**重复 id 记 `ambiguous`
   并退回全表扫描**，于是「更新所有同 id 条目」的语义逐字不变。命中还自校验
   （下标越界或指向别的条目即退回），因为 timeline 存在被整体重建/缩短的路径——
   索引陈旧只丢加速，不读错条目。
4. **`upsert_activity` / tool 与 activity 归约器的 `activities.iter().position(...)`**
   与 **`reduce_interaction` 的「`position` + `retain`」两次全表扫**。⇒ 前者走
   `ActivityIndex::position`；后者删掉重复的那趟（`remove(已知下标)` 取代 `retain`）。

### 结果（同一 harness、同一输入、逐字节等量工作）

native release 折叠（探针读数，2000/2251 事件量级）：

| 量 | 改前 | 改后 |
| --- | --- | --- |
| `[mixed] blocks=200`（2251 事件） | 253.2ms（112.5µs/事件） | **26.4ms（11.7µs/事件）** |
| `[mixed] blocks=400`（4501 事件） | 1036.2ms（230.2µs/事件） | **87.1ms（19.4µs/事件）** |
| `[单类] diagnostic.notice` ×2000 | 2246.7ms | **7.4ms**（−99.7%） |
| `[单类] tool.started` ×2000 | 291.2ms | 407.3ms → 见下 |

> `tool.started` 在「先加索引」那一步反而涨到 407ms：`refresh_orphans` 的改写一开始引入
> 了**逐节点 `parent_id.to_string()`**（为借开 `&mut` 冲突），等于逐事件 O(活动数) 次分配。
> 改成两段式（只读一遍定下标，再逐个 `as_object_mut`）后回到 407→**203µs/事件**。
> 剩下的仍是 O(活动数)/事件——但**TS 基线同样是 Θ(N)**（`activities.map` 每次全扫且每次都
> 分配一个新数组），所以这条是「与基线同复杂度、常数更优」，不是回退。照实记着。

wasm 端到端（脚手架，scale=m，每侧 3 轮中位数）：

| case | 改前 wasm | 改前比值 | 改后 wasm | **改后比值** |
| --- | --- | --- | --- | --- |
| `projectWorkbench(fold) mixed-m` | 223ms | 5.22× | **49.2ms** | **1.18×** |
| `projectWorkbench(paged) paged-replay-m` | 26.5ms | 5.55× | **10.0ms** | **2.25×** |
| `projectWorkbench(fold) mixed-s` | 2.58ms | 6.59× | 2.02ms | 4.31× |
| `projectWorkbench(paged) paged-replay-s` | 1.54ms | 8.68× | 1.14ms | 6.70× |
| `projectWorkbench(fold) coverage-disorder` | 0.08ms | 11.59× | 0.07ms | 9.20× |
| `projectWorkbench(fold) delta-m` | 20.0ms | 7.67× | 20.3ms | 5.72×（TS 侧本次读数 3.55ms，抖动） |

**mixed-m 的 5.8× 是这一轮真正的收口**（生产真实入口、绝对值最大）。delta-m 未动：
它的账在**边界**（宿主编码 7.9ms + 400KiB patch 串的过界与 `JSON.parse`），不在折叠
（核内 project 仅 2ms），属下一轮的结构性改造（patch 走二进制编组）。

### 复验

- `cargo test -p pylon-compute --lib` → **176 passed**（+4 条新等价性测试），0 failed
- 新增测试（都守这一轮的三处索引/缓存，有牙）：
  - `timeline_index_lookup_matches_full_scan`：**故意造重复 eventId**，钉死「唯一才加速、
    重复退回扫描」；含乱序中插（索引唯一的整表重建路径）
  - `update_timeline_fast_path_matches_full_scan`：清空索引逼扫描侧，两侧 timeline 逐字段相同
  - `activity_index_position_matches_linear_scan`：含 `a/tool` 与 `a/activity` 的遮蔽用例
  - `orphan_refresh_skip_matches_full_recompute`：把版本戳顶成 `u64::MAX` 强制全量重算，
    与早退结果逐节点比对
- `bun run test` → `Test Files 622 passed`、`Tests 4688 passed | 1 todo`，0 failed
- `bunx vitest run scripts/compute-parity.test.mts` → 2/2 passed，`ok 172 / known-diff 3 / mismatch 0`
- `bunx tsc -b` exit 0；`bunx eslint src/` 0 error（1 条既存 warning，在
  `RightRailHost.tsx`，非本轮文件）；`cargo fmt --all --check` 通过；
  `cargo clippy -p pylon-compute --lib --tests` 0 warning
- 改动面：`src-tauri/pylon-compute/src/projector/workbench.rs` 单文件（+265/−73）

### 仍未做（下一轮的账，按拆出来的数字排序）

1. **events 层没有切流**（`canonicalEventSink` 仍用 TS）+ 该域 wasm 出口的宿主编码被计进
   比值。要么切流时一并把 `frameOf` 移出计时，要么明确它量的是待接线路径。
2. **边界二段**：宿主帧编码 3.4µs/事件（`encodeProjectorFrame`，已是分块池 + Int32 槽表，
   剩下的账在逐字段 `TextEncoder.encode` 分配）+ patch 走 JSON 字符串（400–812KiB 的
   Rust→JS 拷贝 + `JSON.parse`）。这是 delta-m 5.7× 的全部来源。
3. **① 折叠去 `Value`**：mixed-m 已到 1.18×，剩下的绝对量是逐事件 base cost（约 7µs/事件）
   与 wasm dlmalloc 相对 native 的 ~1.45×（native 26.4ms vs wasm 核内 42ms）。
4. **高亮 1.4–3.8×**：syntect vs starry-night 引擎级差异，绝对值 <1ms。

---

## 24. 宿主帧编码去分配（delta-m 编码 7.45 → 3.30ms）+ live 路径的账：patch 重发累计文本

承 §23 的「仍未做」第 2 项。这一节把**折叠之外的那一半**拆干净，并量出 live 路径真正的
瓶颈——它不在计算核里。

### 24.1 帧编码：逐字段 `encoder.encode` 每次新建 Uint8Array

用「与生产同构、按开关抽掉某一步」的消融编码器（临时探针，已删）对照：

| case | N | 生产 | 同形消融（仅换编码方式） | −encodeInto | −json | −DataView | 三抽 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `delta-m` | 2001 | **6.56ms** | 2.36ms | 1.03 | 1.86 | 2.35 | 0.61 |
| `mixed-m` | 2251 | **7.98ms** | 3.51ms | 1.27 | 2.18 | 3.12 | 0.67 |

即：**逐字段 `encoder.encode(value)`（每次新建一个 Uint8Array）占编码总耗时的 2/3**；
末尾逐事件 `DataView.setUint32` 那 7.6 万次写入只占 ~0.01ms（原本怀疑它，实测不是）。
`Object.entries` → `Object.keys` + 下标循环 + 计数器判空另占约 0.5ms（每事件少两个短命数组）。

落地（`src/infrastructure/compute/projectorCompute.ts`）：
- `putSlot` 改 `encodeInto` 写进**复用 scratch** 再 `slice` 取走——只保留「拷进池」那一次
  memcpy。扩容按 UTF-8 最坏 3 字节/UTF-16 单元估上界，`read` 未走完即原地翻倍重试
  （孤代理 → U+FFFD 的编码语义与 `encode` 一致，字节结果不变）。
- `extra` / `provenanceExtras` 改 `Object.keys` + 下标循环 + 计数器，不再 `Object.entries`
  与第二次 `Object.keys(...)`。语义仍是**只枚举自有可枚举键**。

实测：`delta-m` 编码 **7.45 → 3.30ms**、`mixed-m` **7.88 → 3.19ms**（约 2.3×）。
端到端随之下来：`delta-m` e2e 19.49 → **15.23ms**；`projectorCompute` 边界计数断言未动。

### 24.2 live 逐事件路径：4.07× 的 98% 是「每事件重发整条累计消息」

用户判据里唯一还未兑现的是**逐事件实时折叠**。一进程一段的干净读数（`n=2000`，
每段独立进程，避免 wasm 堆增长污染）：

| 段 | 总耗时 | 单事件 |
| --- | --- | --- |
| ① JS 单事件帧编码 | 10.5ms | 5.25µs |
| ② wasm `appendBatch`（帧已预编码） | **114.2ms** | **57.08µs** |
| ③ `JSON.parse(patch)` | 43.1ms | 21.55µs |
| ④ 生产 live（`foldIntoProjector` 每事件一次） | 168.2ms | 84.04µs |
| ⑤ 迁移前 TS 逐事件（对照） | 38.7ms | 19.35µs |

①+②+③ = 83.9µs ≈ ④ 的 84.0µs ⇒ `applyPatch` + 池登记≈0，账全在前三段。

**② 的 57µs 不是折叠慢，是 patch 大。** 取运行中段的 patch 按字段拆字节：

```
patch 全长 18516B（第 1000 事件）
  timelineUpserts                187B  (1 项)
  messageUpserts               18122B  (1 项)   ← 98%
  appliedRanges / session / 长度位  ~63B
按事件位置：500 → 9510B   1000 → 18516B   1500 → 28517B
patch 总长 36.3MB / 2001 事件
```

**`MessagePatch` 携带的是整条消息的完整值**（`content` 累计文本 + `parts[].text` 同一份
文本，各约一半），而流式每事件只增长一个尾巴 ⇒ **过界字节是 Θ(N²)**（2001 事件 36.3MB）。
②（Rust 建这棵树 + 序列化 + 字符串过界）与 ③（V8 解析并重建这棵树）都按字节付费，
所以两者总共占 live 的 93%。

**这条正是 issue 边界纪律第 2 条（「热路径边界不做 JSON 序列化」）与第 1 条（「禁止逐事件
append」）指向的东西——并且在 live 上尚未落实**：timeline 是增量的（只发新条目），
message 是快照（每次全量）。同一份 patch DTO 里两半的口径不一致。

### 24.3 两条收口路线（设计决策，未动手，等裁断）

| 路线 | 做法 | 收益 | 代价 / 风险 |
| --- | --- | --- | --- |
| **A · 让 `MessagePatch` 真正增量** | patch 增加紧凑形态（如 `{index, contentTail, partTextTail}`），仅当「这条消息本次只被追加」时下发；TS 侧对上一份消息做 append。Rust 在写点记录 O(1) 的「追加前长度 + 尾巴」，`finish_batch` 据此选形态 | 过界字节 Θ(N²)→Θ(N)：live 84µs → 估 ~15µs，**比值跨过 1**（对照 TS 19.35µs） | 动的是 JS↔wasm 的 **patch DTO 契约**（跨语言、有 parity 门禁钉着），且要覆盖「合并可能新增部件」等分支；等价性证据要重跑全套 parity |
| **B · live 侧按帧合批** | `agentWorkbenchSession.foldPage` 把一拍内到达的事件合并成一页再折（纪律第 1 条的正面落实） | 字节同样降 K 倍（K = 每拍事件数），实现极小 | **改变可观测的更新时序**：文档不再在 ingest 后同步更新。消费方（渲染、导出、测试）是否依赖这一点要逐处核 |

**建议 A**：文档形状与加载时序都不变，落在计算核自己的边界契约内，且正是 issue 纪律
第 2 条的字面要求；B 的收益虽同量级，但要先证明没有消费方依赖同步更新。
两者都要用户点头——A 动跨语言契约，B 动时序，都不该由我单方面定（AGENTS §2.3-3）。

### 24.4 本轮复验

- `bun run test` → `Test Files 622 passed`、`Tests 4688 passed | 1 todo`，0 failed
- `bunx vitest run scripts/compute-parity.test.mts` → 2/2 passed（`ok 172 / known-diff 3 / mismatch 0`）
- `bunx tsc -b` exit 0；`bunx eslint src/` 0 error（仍只有 `RightRailHost.tsx` 那条既存 warning）
- 改动面：`src/infrastructure/compute/projectorCompute.ts`（帧编码内部，无契约变化）

---

## 25. 实机验收（真机 → 抓到一个 P0）+ 内存基准

用户 2026-09-21 指定验收实例 `F:\A-I\Platform\Pylon`，并要求「除了速度，内存占用也相当重要」。
按 `[.agents/skills/webview2-acceptance]` 走：备份 → 换 exe → 带调试端口启动 → 连 CDP 取证。

### 25.1 【P0】打包态 CSP 挡住 wasm 取回：计算核在打包应用里**从未加载成功过**

首次连上（`webview2-mcp`，Edge 153 / V8 15.3）读控制台，四条即两件事：

```
[exception] TypeError: Cannot read properties of undefined (reading '__wbindgen_export')
    at new Qe (first-party-pylon-renderers-CGCHObm6.js)      ← new PylonProjector(...)
    at ce/fe (workbenchProjector-0ZJTbad9.js)                  ← createProjector
    at Object.bind (AgentSheetView-lT5yXeyDi.js)               ← agent sheet 绑定
[log/security] Connecting to 'http://tauri.localhost/assets/pylon_compute_bg-CD2CvqhT.wasm'
    violates the following Content Security Policy directive:
    "connect-src ipc: http://ipc.localhost asset: http://asset.localhost pylon-plugin: ..."
[log/javascript] Fetch API cannot load .../pylon_compute_bg-CD2CvqhT.wasm.
    Refused to connect because it violates the document's Content Security Policy.
```

**根因**：`src-tauri/tauri.conf.json` 的 `csp.connect-src` 是**唯一没有 `'self'` 的取值指令**
——`default-src`/`img-src`/`style-src`/`script-src`/`font-src` 都有它，只有管 `fetch()` 的
`connect-src` 没有。于是打包后页面源 `http://tauri.localhost` 取自己的 `assets/*.wasm`
被 CSP 拒；`script-src` 里的 `'wasm-unsafe-eval'` 形同虚设（拿不到字节）。

**为什么所有轮子都绿**：`devCsp.connect-src` 显式列了 `http://localhost:5173`，dev 页面源
正好是它 ⇒ 同源 fetch 恰好放行。**只有打包态能看见**——正是 skill 里「单测与浏览器 mock
证明不了真实宿主」那条。而 #220 之前的应用不 fetch 任何 wasm，所以这是本 issue 引入的缺陷
（`github/main` 上无 `src/infrastructure/compute/pylonCompute.ts`，已核对）。

**后果**：打包应用里的**每一条**已迁移计算路径（投影、流式切分、揭示预算、markdown、高亮）
全部走不到——投影核构造函数在 wasm 未初始化时直接抛。功能上等于 #220 在发行包里 0 上线。

**修法**（两行）：`csp` 与 `devCsp` 的 `connect-src` 各补 `'self'`。

**复验**（换 exe 后同一路径）：
```
GET http://tauri.localhost/assets/pylon_compute_bg-CD2CvqhT.wasm
  → status 200, mimeType application/wasm, 841,273 B, 17ms
GET http://tauri.localhost/assets/pylon_markdown_bg-BLvHjJYQ.wasm
  → status 200, mimeType application/wasm, 2,873,113 B, 43ms
全量扫描 console：Content Security Policy 命中 0 条
```

### 25.2 同轮发现（未修，交给 owner 判）· 首次使用竞态

CSP 修好后这条**仍然复现一次**（时间戳证明是同一动作内、fetch 前 59ms）：
打开 agent sheet 时 `AgentSheetView` 的绑定路径走到 `projectWorkbench`（**纯函数同步出口**）
→ `createProjector` → `new glue.PylonProjector(...)`，而此刻 wasm 还没就绪 ⇒ 同一个
`__wbindgen_export` TypeError。

- **性质**：一次性竞态，不是持续故障。核暖后开第二张 agent sheet（`Hermes\default`）
  再读增量控制台 **0 条新错误**；sheet 也正常渲染出来了（截图与 `role=tab` 读数佐证）。
- **为什么不该由我顺手改**：`whenProjectorComputeReady()` 是异步门，而 `projectWorkbench` /
  `reduceWorkbenchFold` 是**同步纯函数出口**，天生无法自己等待；要么绑定侧 await、要么让同步
  出口在未就绪时抛一条人话错误。两条都动 `AgentSheetView` / 纯函数 API 的契约，且
  「抛错 vs 等待」是行为选择 ⇒ 留证据与两条路线，请 owner 定。
- 现状危害：控制台一条 TypeError + 首帧可能少一次渲染，用户可见影响未观察到。

### 25.3 功能复验：两次真实 agent 回合，全绿

在 `Hermes\default`（**无工作区**，避免真机 agent 落到工作区改文件）发两条明确要求
「不调用任何工具」的短提示：

| 回合 | 内容 | 结果 |
| --- | --- | --- |
| 1 | 纯文本答复 | 消息与回复正常渲染，处理耗时 6s，新会话 `session-mub4qux1` 入列 |
| 2 | 要求输出 TypeScript 代码块 | `pre/code` 命中 2 处（高亮真的工作），消息数 5 |

- 两回合期间 console **0 条错误/异常**，`tauri_backend_logs` 按 `level=error` 查 **0 条**。
- 一次真实回合走完了 canonical → 投影核（wasm）→ 渲染，第二次额外走了 markdown 解析 + 高亮（wasm）。

### 25.4 内存读数

**真机（Edge 153 / V8 15.3，进程 `pylon.exe`）**——in-page 探针在 reload 前用
`Page.addScriptToEvaluateOnNewDocument` 包一层 `WebAssembly.instantiate*` 记录 `memory`：

| 时点 | compute 核线性 | markdown 核线性 | JS 堆 | 进程 WS | 进程 Private |
| --- | --- | --- | --- | --- | --- |
| 启动（tasklist 初读） | — | — | — | 49.3MB | — |
| 核装载后（2 张 agent sheet） | **1.125MiB** (1,179,648B) | 未装载 | 13.7MB | 51.9MB | 137.4MB |
| 两次真实回合后（含代码块高亮） | 1.125MiB | **2.375MiB** | 16.5MB | **61.6MB** | 198.7MB |

⇒ 真机稳态：**两个计算核合计 3.5MiB 线性内存**，进程 WS 约 62MB。核本身的占用在真机上很小。

**Node 宿主脚手架（`scripts/compute-parity-memory.mts`，新增）**——把每个出口跑一遍
m 档全表后的核高水位：

| 计算核 | 装载后 | 跑完全表高水位 |
| --- | --- | --- |
| `pylon-compute` | 1.13MiB | **99.44MiB（+98.31MiB）** |
| `pylon-markdown` | 2.38MiB | **94.50MiB（+92.13MiB）** |

单次调用把高水位抬起来的量（`核线性Δ` 列）：`projectWorkbench(fold) delta-m`（2001 事件）
**+2.63MiB**、`mixed-m`（2251 事件）**+5.13MiB**、`paged-replay-m` +8.06MiB；
xs/s 档普遍 0.0K（分配器复用得上）。`markdown-highlight` 逐语言约 +11MiB（syntect 语法装载）。

**两条读法上的纪律**（已写进 `harness.ts` 与脚手架 README，避免后人混读）：
- `核线性Δ` 必须是**单次调用**的增量：线性内存是高水位、只涨不跌，重复调用不会再涨；
- `wasm保留/次` 没有 `--expose-gc` 时是**上限**，输出头会点明状态（本轮用
  `NODE_OPTIONS=--expose-gc` 取到精确值，故 `ts保留/次` 出现负数——GC 后比基线还低，
  说明该口径有地板噪声，故比值列在 ts 侧 ≤1B 时显示 `—`）。
- 结论只写有把握的那半：**核的线性内存不归还，高水位由最大单次输入决定**；
  真机当前用不到 m 档以上的折叠，所以稳态 3.5MiB 与脚手架的 190MiB 不矛盾——
  后者是「把所有出口的 m 档都跑一遍」的累计高水位。

### 25.5 新增门禁：`check:csp`（防这一类复发）

本轮所有既有门禁（lint / tsc / 622 个测试文件 / bundle / docs / deps / CI）对 25.1 都是瞎的
——它们看不见打包态 CSP。新增 `scripts/check-csp-self.mjs`：断言 `csp` 与 `devCsp` 里
**凡管取资源的指令**（`connect-src` 硬要求，其余存在即查）都含 `'self'`，并接进
`check:frontend` / `check:frontend:static`（`check:csp`）。

- 正向：`bun run check:csp` → 通过（6 条口径）
- **负向对照**：临时摘掉 `csp.connect-src` 的 `'self'` → 门禁红并指名该指令
  （`✗ csp.connect-src 没有 'self'：ipc: ...`），随即恢复。有牙。

### 25.6 本轮改动面与复验

| 文件 | 性质 |
| --- | --- |
| `src-tauri/tauri.conf.json` | 修 P0：两处 `connect-src` 补 `'self'` |
| `scripts/check-csp-self.mjs` | 新增门禁（含负向对照） |
| `package.json` | 接 `check:csp` 进两条 frontend 门禁链 |
| `scripts/compute-parity-memory.mts` | 新增内存跑器入口（用户要求的「适当改造脚手架」） |
| `scripts/compute-parity/harness.ts` | 新增内存跑器（结果字节 / 核线性高水位 / 单次保留量）+ 分域汇总 |
| `scripts/compute-parity/README.md` | 补内存跑法 + 三列口径差别 |

复验：`bun run check:csp` 通过、`check:docs` exit 0、`check:deps` exit 0；
真机两次真实回合 0 错误（见 25.3）。

### 25.7 仍未做

1. 25.2 的首次使用竞态——待 owner 在「绑定侧 await」与「同步出口抛人话错」之间定。
2. **实机性能前后对比**（验收项第 5 条）：本轮量了内存与功能，没量速度对照。要做需要把
   迁移前的 exe（`pylon.exe.bak-before220` 是同分支旧构建，**不带** wasm 核；真正的
   「迁移前」是 `76cbc819^` 的构建）装上跑同一会话夹具——属独立一轮。
3. 本次验收在真机装的 exe 为本地 release 构建（36,479,488 B，已留
   `pylon.exe.bak-before220` 备份）；验收后已关闭该实例，调试端口不再暴露。

---

## 26. 基准复跑（在途状态：本人已提交 + 他人路线 A 的 WIP）

**测的是什么状态**：`src-tauri/pylon-compute/src/projector/workbench.rs`（+722 行）、
`src/infrastructure/compute/projectorCompute.ts`（+86）、`projectorComputeParity.test.ts`
上有**他人的在途改动**，内容是记录 §24.3 的**路线 A**（`MessageAppendPatch`：patch 带
`contentTail` / `lastPart` / `pushedParts` 的紧凑追加形态，TS 侧 `applyMessageAppend` 展开）。
该状态**能编译**（`cargo check -p pylon-compute --lib` 干净），故本轮数字是「本人已提交的
工作 + 对方路线 A 的 WIP」的合成态，**不是任何一个提交点**。产物重建于本轮
（`pylon_compute_bg.wasm` 859,914 B）。机器空闲（CPU 2%，无 cargo/rustc）。

### 26.1 parity 门禁

`175 项：ok 172 / known-diff 3 / mismatch 0`（3 条仍是预期的孤立代理 / 脚注 / 高亮 js）。

### 26.2 速度（`compute-parity-bench.mts`，scale=m，每侧 3 轮中位数）

分域（wasm 占优 / ts 占优 / 总数）：canonical 0/6、events 1/25、**projector 0/18**、
streaming-split 20/69、streaming-budget 7/2、**markdown-parse 17/0**、markdown-highlight 2/8。

| projector case | ts(ms) | wasm(ms) | ratio | 会话起点 | 上一轮 |
| --- | --- | --- | --- | --- | --- |
| `fold mixed-m` | 45.02 | 46.57 | **1.03×** | 5.22× | 1.18× |
| `paged paged-replay-m` | 5.08 | 10.59 | 2.08× | 5.55× | 2.25× |
| `fold delta-m` | 3.09 | 20.00 | 6.48× | 7.67× | 5.72× |
| `fold mixed-s` / `delta-s` | 0.41 / 0.30 | 1.82 / 1.16 | 4.49× / 3.81× | 6.6× / 4.3× | — |
| `fold coverage-disorder` | 0.01 | 0.06 | 7.73× | 11.6× | 9.2× |
| `paged idempotent-refold` | 0.07 | 0.51 | 7.43× | 8.4× | 8.9× |

其余域的关键行：`parseMarkdown doc-m` **0.10×**（wasm 快 10×）、`doc-s` 0.09×；
`highlightBlock` 0.62–3.0×（引擎级）；`canonical` 1.94–6.33× 与
`streaming-split` 的 xs 行（绝对值 < 0.05ms，纯过界开销）；`events` 批量出口 12.75–151×
——**注**：那几条的 wasm 侧把脚手架 fixture 的 JS 帧编码计进了计时（§23 已定位），
且 events 层未切流，比值不代表计算核。

### 26.3 live 逐事件（生产路径，一进程一段，n=2001）

| 段 | 本轮 | 本人修完折叠扫描后 | 变化 |
| --- | --- | --- | --- |
| JS 单事件帧编码 | 3.71µs | 5.25µs | −29% |
| wasm `appendBatch` | **14.46µs** | 57.08µs | **−75%** |
| patch `JSON.parse` | **2.24µs** | 21.55µs | **−90%** |
| **生产 live 全路径** | **31.24µs** | 84.04µs | **−63%** |
| 迁移前 TS（对照） | 20.13µs | 19.35µs | — |
| **live / TS** | **1.55×** | 4.07× | — |

patch 传输总量 **1.0MiB / 2001 事件**（此前 **36.3MiB**，**36× 少**）——这正是路线 A 的靶子：
紧凑追加形态取代了「每事件重发整条累计消息」。

剩余 live 缺口（31.24µs 里）：`appendBatch` 14.46 + 编码 3.71 + parse 2.24 ≈ 20.4µs，
其余 **~10.8µs 落在 JS 侧 patch 应用**（`applyMessageAppend` + 文档重建 + 池登记）。
本人上一轮测同一项时该段 ≈0 ⇒ 这 10.8µs 是路线 A 新引入的 TS 侧成本，**属对方未完成的半成品**，
照实记，不代改。

### 26.4 冷装载 20k（1000/页，一进程一配置）

| case | 三次读数 |
| --- | --- |
| `cold-ts`（迁移前 TS） | 34.5 / 24.6 / 29.0 ms |
| `cold-wasm` | 233.9 / 268.5 / 191.4 ms |

比值 6.8–9×，**读数噪声大**：单进程内把 20k 事件折完会把 wasm 线性堆顶到 ~280MB，
之后每次 `memory.grow` 都要搬整块线性内存（记录 §17 已登记的宿主假象）。
这个数**不是核的计算时间**；要稳定读数需按页独立进程，属未做。

### 26.5 内存（`compute-parity-memory.mts`，`--expose-gc` 精确保留量）

核线性内存高水位（跑完 m 档全表，**只涨不跌**）：`pylon-compute` 1.13 → **99.44MiB**；
`pylon-markdown` 2.38 → **94.50MiB**。单次调用抬高量：`fold delta-m` **+2.63MiB**、
`fold mixed-m` **+5.13MiB**、`paged-replay-m` 单次 0（复用得上）。
保留/次：`delta-m` 1.19M、`mixed-m` 1.60M；TS 侧 ≈0 或负（口径地板噪声，比值列显示 `—`）。

**同 workload 持有成本对照**（`bench-memory-hold.mts`，两侧文档形状逐项核对等量）：

| 文档形状 | ① TS 文档 | ② wasm（核内 + JS 物化） | ②/① | ③ 核线性峰值保留 | ③/① |
| --- | --- | --- | --- | --- | --- |
| delta 2001 条 | 0.36MiB | 1.59MiB | **4.46×** | 8.19MiB | 23.0× |
| mixed 2251 条 | 0.50MiB | 3.04MiB | **6.05×** | 14.06MiB | 28.0× |

⇒ **纯 TS 实现的文档内存明显更低**，且对象越多差距越大（`serde_json::Value` 结构成本）。
路线 A 只消掉**过界传输**（36.3MiB → 1.0MiB），不消核内的那份文档；要动那一份仍是「① 去 `Value`」。

## 27. live `MessagePatch` 紧凑追加形态落地（§24.3 路线 A 收口，19 点档）

用户裁决到位（「把不属于计算核的那一个事件解决一下」即放行 §24.3 的**建议 A**），
路线 A 本轮完工。spec：`.agents/spec/220-live-message-patch-incremental.md`。

### 27.1 契约

`MessagePatch` 变双形态（互斥、恰有一者）：

- **全量** `{index, message}`：任意变更（settle/替换/批内追加区），既有形态不变。
- **紧凑** `{index, append}`：本批对一条**既有**消息只做了一次纯文本追加——
  `{contentTail, lastPart?, pushedParts?, identity?, sequence?, running?}`。
  `lastPart` 是 `textTail`（文本尾巴 + kind 覆写；language 仅 reasoning 收敛携带，
  `null` = 移除）或 `rewritten`（末部件整值，表达力兜底）。

**判据在写点自证，不靠事后 diff**：四个追加写点（message/reasoning 的主追加与乱序收敛）
改走 `mark_message_append(index, flavor, mutate)`——变更前 O(1) 预扫描（content/parts 长度、
末部件标量、标量指纹），闭包原地变更，变更后从前后差重建记录。任一表达力条件不满足
（同批第二次变更、批内 push 后 append（TS 无批前基准）、reasoning 重建丢自有键、
指纹出圈）即**静默降级全量**——降级只回到今天的形态，语义恒对。

TS 侧 `applyPatch` 对 `append` 条目就地应用（`applyMessageAppend`）：content 字符串拼接
（cons-string 摊销 O(1)）、parts 浅拷贝只碰末部件、标量按 presence 覆写。展开保留上一份
键序，wire 键序本就字典序 ⇒ 逐字节 JSON 断言不受影响。紧凑条目缺批前基准 = 契约破坏，
抛错而非静默陈旧读。

### 27.2 等价性证据

- Rust `change_ledger_tests`：`resolved_messages` 把紧凑条目对批前消息**应用后**与
  `diff_patches` 参考值逐字节比对——「记账 ⊇ diff」不变量在紧凑形态下继续成立
  （该应用逻辑是 TS `applyMessageAppend` 的 JSON 层镜像）。
- 新增 5 个 Rust 单测：流式 delta 产紧凑形态且应用后等值、二换单事件降全量、
  批内 push+append 降全量、kind 翻转走 TextTail.kind、reasoning 自有键降 Rewritten。
- TS 侧新增 3 个边界测试（`projectorCompute.test.ts`）：逐事件折叠产 append 形态且与
  整页折叠收敛同一文档、kind 翻转生效、不合族部件走 pushedParts 且与全量等值。
- 未漂移的标量不下发（如 started 后 running 恒 true）——省字节的正确行为，测试钉住。

### 27.3 读数（bench 新增「场景 E · live 逐事件」：回合流 + §24.2 同形长流，n=2000）

| 形状 | 指标 | 改前 | 改后 | 变化 |
| --- | --- | --- | --- | --- |
| 长流（§24.2 同形） | patch 总字节 | 82.02MB | **1.10MB** | **74×** |
| 长流 | 生产 live | 402.99µs/ev | **24.63µs/ev** | **16.4×** |
| 长流 | ② appendBatch / ③ parse | 276.05 / 77.94µs | 7.08 / 2.34µs | −97% |
| 回合流 | patch 总字节 | 2.38MB | 1.97MB | 1.2× |
| 回合流 | 生产 live | 95.96µs/ev | **32.02µs/ev** | 3.0× |

字节量是确定性判据；耗时单进程单轮、供方向参考。与 §26.3 的独立复测（WIP 合成态
31.24µs / 1.0MiB）互相印证。**Θ(N²) 已消**：长流 patch 尺寸不再随消息长度增长。
回合流剩余 ~1KB/事件主要是 session 面整携带 + timeline 条目，属 patch DTO 其余维度，
不在本路线靶内。

### 27.4 门禁

`cargo test -p pylon-compute` 181 通过（含新增 5）；clippy/fmt 干净；`bun run test`
623 文件 / 4698 通过 | 1 todo（含并行会话同树落地的 CSP/竞态/内存三项，联合验证）；
`tsc -b` 0 错；`eslint src/` 仅剩既存 RightRailHost warning；parity 2/2 通过；
`check:bundle` wasm 段 PASS（841KB，预算内）。

### 27.5 协作记账（同树并行）

本轮施工期间，另一会话在同一工作树施工 #220 的 CSP/竞态/内存三事（`8339e966`…`9a8ecec5`），
其 `d2af1a43` 按 AGENTS §2.1 声明绕开了本轮的在途 workbench.rs（当时正处于「缺 index 字段」
的编译红状态），全程 pathspec、未触碰本路线文件域；其 §26.3 基准与本路线互为独立复测。
`scripts/bench-live-probe.mts`、`src-tauri/pylon-compute/src/projector/value_memory_probe.rs`
两份未跟踪文件归对方所有，本轮未触碰、未提交。
