# Dev Record — #193 前端测试提速四件套 + 后端指纹收尾

> 入库保留。规格文档（spec）不保留，结论在此承接。

## 元信息

- issue：#193（refactor，assignee: Kan）
- 分支：`Ru5t/Reflector`
- 提交范围：`e181e278..<head>`（叠在 #184 提交之上，同分支同 PR）
- 日期：2026-09-19

## 目标与范围

用户批准的四项前端测试提速（mock 工厂 / transform 缓存 / CI 分片 / react-shared 共享环境）+ 用户追加的 fake agent 修复评估与后端编译收尾（generator 指纹对齐）。**不做**：happy-dom、合并测试文件、Rust harness 重构（ADR-0005 已覆盖）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/test-utils/tauriCoreMock.ts` | 新增：`@tauri-apps/api/core` mock 形状单一来源（invoke vi.fn + Channel 类），行为由各文件 handler 传入 | 新增 |
| 52 个 `src/**/*.test.{ts,tsx}` | `vi.mock('@tauri-apps/api/core')` 内联工厂迁移为共享工厂调用（38 个 codemod + 14 个手工） | 修改 |
| `.github/workflows/ci.yml` | frontend 拆为 frontend（静态门禁）+ frontend-test（`--shard` 2 分片矩阵）；两 job 加 `node_modules/.vite` transform 缓存 | 修改 |
| `package.json` | 新增 `check:frontend:static`（check:frontend 去掉 test 段；check:frontend 本地语义不变） | 修改 |
| `scripts/generate-acp-golden-trace.mjs` | cargo test 加 `--features test-agent`（基线已验证 feature 无关） | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | 验证节同步五 job 结构与 mock 工厂/共享环境表述 | 修改 |

## 方案要点

1. **mock 工厂只统一形状、不统一行为**：52 份内联 mock 的 invoke 实现各不相同（invokeRef 转发 / vi.hoisted / 固定返回三种惯用法），工厂接收 handler 参数、逐文件原样搬运行为表达式——语义零变化。Channel 类（2 处重复拷贝）收敛进工厂。
2. **vi.mock 提升陷阱的规避**：工厂内部 `await import('相对路径')` 动态获取 helper（顶层 import 会被提升导致 TDZ）；相对路径按文件深度计算。
3. **react-shared 共享化试点后回退（本记录的负结果）**：97 个无 vi.mock 的 jsdom 文件翻 `isolate: false` 后实测——environment 累计仅 296s→280s（本地墙钟收益 ~2s 量级），且全量轮次中出现 2 次 solid-dom 隔离组的时序敏感测试抖动（CollapsiblePresenter ×2，单独跑 3/3 全绿、共享化还原后对照 3/3 全绿，共享化期间 2/8）。收益微小 + 调度干扰风险，按预登记回退预案撤销；DOM 套件维持 per-file 隔离（`vitest.config.ts` 原样）。
4. **CI 分片**：`bun run test --shard=N/2`（bun run 透传参数，已验证）；`fail-fast: false` 保证一分片失败仍跑完另一分片收集全部信息。
5. **generator 指纹对齐的前提验证**：带 `--features test-agent` 重新生成 golden trace 与已提交基线逐字节一致（仅差基线目录内的 README.md，非生成产物）→ feature 无关 → 对齐安全。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 全量 vitest 连续全绿（最终态：mock 工厂迁移后） | 对照实验态连续 3 轮全绿（606 文件 / 4439 用例）；历史 11 轮中仅 2 次 solid-dom 隔离组时序抖动（与共享化试点同期，还原后未再现） |
| 52 处 mock 迁移语义不变 | 全量绿 + tsc -b 干净 + eslint 干净；零残留（grep 旧形态 0 命中） |
| generator --check 对齐后通过 | exit 0，与基线一致 |
| CI frontend / frontend-test 全绿 | 待 PR run 回填 |

## 测试处置

无测试行为修改；52 文件的 mock 块为机械迁移（行为表达式逐字保留）。

## 证据

- codemod + 修复脚本执行输出（本会话记录）：A:22 / B:14 / C:1 / D:1 + 手工 14；修复 24 文件（3 处相对路径深度错 + 21 处 codemod 吞换行的语句拼接）
- 全量验证：606 文件 / 4439 passed | 2 todo（4441）
- 旧形态残留：`grep "vi.mock('@tauri-apps/api/core', () =>"` → 0

## 与 spec 的偏差

1. spec（issue 正文）设想「mock 工厂 + 默认 handler 集中」——实施改为「形状集中、行为 per-file 传参」：52 份行为的默认值互不相同（`[]` / `null` / `{}` / 路由表），统一默认值必然改变语义，传参搬运才是零语义变化的形态。
2. 追加了 spec 没有的 generator 对齐（用户「fake agent 顺手加入修复清单」+ 编译收尾授权范围），前提是先做了 feature 无关性验证。

## 未解问题

- react-shared 共享化的 CI 表现（4 vCPU worker 数与本地 10 worker 不同，泄漏若只在 CI 显形则回退该组隔离）。
- 本地全量墙钟（87s vs 基线 75s）受开发机并行负载干扰（同工作树有 #110 施工），收益以 CI 分片与 environment 累计值（296s → 280s）为准。

## 并行交集

52 个测试文件 + `vitest.config.ts` + `package.json` + `ci.yml`。Huygens #110 域无交集（其测试文件不在本次迁移清单——已核对 L.md 声明）。
