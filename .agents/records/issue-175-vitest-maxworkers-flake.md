# Dev Record — #175 全量并行 jsdom 调度型测试偶发超时（20 核自饱和饥饿）

## 元信息

- issue：#175
- 分支：`Ru5t/Reflector`
- 提交范围：`67263bea..本次 PR head`
- 日期：2026-09-19

## 目标与范围

全量 `bunx vitest run` 在轮次间偶发 1–4 条超时类失败且失败集合轮间漂移（solidRendererSurface / KernelRoot / issue150）。目标：**单 agent 独占机器上连续 5 轮全量全绿**，不改断言、不加 retry。**不做**：放宽任何 waitFor/测试预算、更换 pool 类型、放松 DOM 套件 isolate（正确性约束见 vitest.config 注释）。

## 根因定位（诊断链）

1. **排除被测改动**：#129 会话内 5 轮全量（含 2 轮 stash 基线对照）失败集合漂移且基线同样红；涉事测试 import 图与改动零交集。
2. **可复现性**：co-agent 停工、机器独占后，默认并行度基线 **2/2 轮必红**（R1: solidRendererSurface + issue150；R2: solidRendererSurface）——无需外部负载即复现。
3. **机制一（CPU 饱和假设，不完整）**：vitest 非 watch 默认 `availableParallelism` 并行度（`resolveMaxWorkers`：`Math.max(numCpus - 1, 1)` = 19 worker），5 个 project 共一个 group；全量启动阶段 transform + jsdom setup 打满 20 核。
4. **机制二（内存分页，关键）**：本机 16GB，本底已占 ~14GB（ZCode 宿主 2.3GB、模拟器 1.3GB、编辑器等）。19 worker × ~300MB ≈ 5.7GB 峰值需求 → **分页** → 事件循环整段冻结。冻结解释了为何 waitFor 连自己的 1s 预算都死、由 30s 测试看门狗收尸（KernelRoot 实测 30017ms 失败）——**预算加倍无意义，分页才是墙钟崩塌的根源**。
5. **修复假设**：压并行度 → worker 内存峰值回落 → 分页消失 → 定时器及时派发。实测成立（见下）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `vitest.config.ts` | 根 `test.maxWorkers`：`availableParallelism >= 12 ? '50%' : undefined`（20 核开发机 = 10 worker；CI 4 vCPU 维持上游默认） | 修改 |

零断言改动、零预算改动、零 retry。`'50%'` 由 vitest 配置解析期 `resolveInlineWorkerOption` 归一为数字（已核 node_modules/vitest/dist 实现）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 实验：`--maxWorkers=10` ×2 轮 | ✅ 2/2 全绿，131-135s/轮 |
| 出口判据：配置修复后连续 5 轮全量全绿 | ✅ 5/5 全绿（见证据） |
| 速度 | ✅ 满载默认 177-213s → 限worker 131-135s（**更快**：分页消失吞吐反升） |
| CI 行为不变 | ✅ `availableParallelism >= 12` 门：4 vCPU 的 CI 走上游默认 |
| 断言/预算/retry | ✅ 一字未动 |

## 证据

- 基线（默认并行度，独占机器）：R1 `2 failed`（solidRendererSurface + issue150）、R2 `1 failed`（solidRendererSurface）。
- 实验（CLI `--maxWorkers=10`）：R1 `602 passed` 134.87s；R2 `602 passed` 130.95s。
- 出口验证（配置 `'50%'`）：5 轮连续 `602 passed / 0 failed`（见 issue 评论附计数）。
- 内存采样：运行中 free 物理内存 1.2-1.5GB；机器 15.7GB 总量。

## 与 spec 的偏差

未写 spec（诊断型任务，方案随取证收敛）；L.md 2026-09-19 02 条目声明了「可能微调两条 waitFor 预算」——**实际未动任何预算**，分页根因下预算加倍无意义。

## 未解问题

- 双 agent 并发施工场景（本机本底吃紧时）仍建议避免同时跑全量测试——cap 已把峰值压到可共存，但极端内存压力下（free < 1GB）任何墙钟敏感测试都可能抖动。
- `solidRendererSurface` 的 waitFor 5s / testing-library 的 1s 默认预算在分页消除后实测够用；若未来 CI 机器出现同型红，#157 式「放大预算」是后备手段，本轮未动。

## 并行交集

- `vitest.config.ts`（共享门禁文件）：已按 L.md 2026-09-19 02 条目声明。sidebar 负责人的 L.md 条目（#154 域）与本改动无交集。
