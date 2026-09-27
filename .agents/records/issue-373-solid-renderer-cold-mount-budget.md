# Dev Record — #373 solidRendererSurface 的 2s 预算吃不下冷挂载

## 元信息

- issue：#373
- 分支：`kumo/prometheus`
- 提交范围：`989cb053..<本次 PR head>`
- 日期：2026-09-26

## 目标与范围

issue 期望原话：「这条用例断言的是『挂载后能渲染出内容、更新不换 DOM 节点、销毁能清理』——**不是**『冷启动多快』。冷启动耗时不该算进它的预算里。」

做：把「现场转译 + 动态 import 渲染器图」的冷启动成本从第一条用例的 `vi.waitFor` 2s 预算中结构性移出；并按 issue 评论要求核查 e8d6d9ce（#228 批次F）同批收紧的其余 7 处预算点是否同雷。

不做：不改任何生产代码（facade 懒加载设计本身正确）；不抬高任何预算数值（候选 (b) 与 #175「零预算改动」原则冲突且方向不对）；不做全局预热（候选 (c) 加重 #175 点名的 jsdom worker 内存压力，一处病灶全体买单）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/plugins/core/renderer/__tests__/solidRendererSurface.test.ts` | 第一条用例 mount 前新增 `await loadSolidMessageRendererComponent()` 预热 + 新增 import + 两段预算依据注释改写 | 修改 |

## 方案要点

- **修法 = issue 候选 (a) 主推变体（用例内预热 loader）**。`import()` 模块缓存保证 mount 内（`solidRenderer.ts:51-55`）的二次加载是缓存命中，waitFor 预算此后只考 warm 首帧刷写（ms 级）；冷启动改由 30s 测试级看门狗（vitest.config `testTimeout: 30_000`）兜底。
- 选预热 loader 而非 `await handle.ready`：`RenderSurface.mount` 契约返回 `unknown`（`contracts/messageRenderer.ts:55`），后者需测试内类型断言；前者零转换、意图显式。
- 2s 数值不动，注释改写为真实前提：#228 批次F 定 2s 的依据「常态 <50ms」只对热态成立，冷启动从未进过它的取样。
- **其余 7 处预算点核查结论：不同雷**。e8d6d9ce 同批收紧的点全部位于静态 import 组件图的测试文件（`mountSolidWorkbench.solid.test.tsx` ×2、`MessageRow.solid.test.tsx` ×2、`ReasoningStates.solid.test.tsx` ×1、`StreamingIdentity.solid.test.tsx` FLUSH_BUDGET；`issue5` 的 REVEAL_BUDGET 4s 是保留项不在 8 处内）：冷启动成本落在文件加载期（任何测试预算之外）。这与「全量 4856 用例只有这同一条红」实证吻合。唯一的结构性差异是本文件：facade 导入期刻意不加载渲染器图 ⇒ 首次挂载必然冷、且被预算裹住。
- 预热顺带惠及同文件第二条用例（destroy-不复活）：其 mount 变暖，但 destroy 同步先于 import 完成，`handle.destroyed` 守卫语义不变。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 隔离跑 2/2 绿（含清 `node_modules/.vite` 冷转译轮） | ✅ 修后 4 轮全绿（3 暖 + 1 冷），每轮 `Tests 2 passed (2)` |
| 变异检查：内容缺席时用例必须红 | ✅ mount 目标临时换游离 div ⇒ `AssertionError: expected '' to contain 'chunk-0'`（与 issue 签名一致）在 2s 预算处红；复原后回绿 |
| 全量绿、用例总数不减少 | ✅ `652 files passed + 1 skipped (653)` / `5008 passed \| 1 skipped \| 1 todo (5010)` / 0 failed，95.08s |
| 如实记录本机状态 | ✅ 见下「证据」 |

## 测试处置

- 修改既有行为测试：`solidRendererSurface.test.ts` 第一条用例——仅前置预热与注释，断言集合（chunk-0 / DOM identity / chunk-1000 / 销毁清理 / 无 error）一字未动；预算数值未动。
- 新增/删除测试：无。

## 证据

- 本机（win32/x64）当轮状态：**红灯未复现**——清缓存后冷挂载实测 ~0.9s（`transform 783ms`，用例 893-912ms），能挤进 2s。issue 机器同路径实测 3788ms > 2s（探针 warm 26ms）。两侧数据共同证明预算考的是**机器相关的转译+加载墙钟**，本机当下处于快态而已；修法把该变量整体移出预算窗口，不再依赖机器状态。
- 全量：`Test Files 652 passed | 1 skipped (653)`，`Tests 5008 passed | 1 skipped | 1 todo (5010)`，EXIT 0，95.08s（用例数较 issue 时 4856 增长来自期间 main 合入的其他工作，本改动零新增用例）。
- 变异检查：临时 `surface.mount(document.createElement('div'), …)` ⇒ `1 failed | 1 passed (2)`；复原 ⇒ `2 passed (2)`。

## 与 spec 的偏差

无。spec（`.agents/spec/373-solid-renderer-cold-mount-budget.md`，不入库）的方案、验收与结果一致。

## 未解问题

- 无。#175 记录「未解问题」里预留的后备手段（放大预算）因本修法而不需要动用。

## 并行交集

- 共享文件：仅 `.agents/L.md`（已按规范单独提交声明）。在途 #372（`resources/release/**`、`scripts/pack_release.py` 等）与本改动零交集，未触碰其文件。
