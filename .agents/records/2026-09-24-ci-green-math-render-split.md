# Dev Record — CI 转绿修复：mathRender 纯模块拆分 + 边界登记

> 入库保留。跨域 CI 修复记录（#267 文件域接管 + #269 域外登记），随分支 PR #268 交付。

## 元信息

- issue：#267（CI 红）、#269（边界登记）、#270/#271（其 PR 门禁被连坐阻塞）
- 分支：`kumo/prometheus`（堆叠 PR #268）
- 提交范围：`03d47b30..`（本条）
- 日期：2026-09-24

## 现状与根因

CI run 35894284095 四 job 红（静态门禁 / clippy 基线 / shadow parity / fmt+test+构建），全部收敛到同一根因：

1. **tsc TS2322 ×3**（mathRender.solid.tsx 46/50/53）：`issue267.mathCache.test.ts`（.test.ts，被主 tsconfig 的 React JSX 语义检查）`import { renderMathMarkup } from '../mathRender.solid.tsx'`——exclude 不挡 import 追随，组件文件被拖进 React 项目，`class`/`innerHTML` JSX 属性爆类型。本地未复现是因为 #272 会话在共享工作树里**未提交地删除**了该测试；CI 干净检出则必红。Rust 三个 job 的前端构建前置步骤（dist 内嵌进二进制）连带全灭——clippy/fmt/cargo 根本没跑到。
2. **eslint `no-useless-assignment`**（mathRender.solid.tsx:24）：`let markup: string | null = null` 的初始化器属死赋值（try/catch 两臂必赋值）。

## 修复

| 文件 | 改动 | 性质 |
| --- | --- | --- |
| `src/renderers/solid-workbench/chat/mathMarkup.ts` | **新增**：`renderMathMarkup` 纯函数 + 缓存自 mathRender.solid.tsx 迁入；初始化器移除（no-useless-assignment 消失），文件头注明拆分缘由 | 新增 |
| `src/renderers/solid-workbench/chat/mathRender.solid.tsx` | 只留 `MathRender` 组件；`export { renderMathMarkup }` 转出保持既有公共面；头注释更新 | 修改 |
| `src/renderers/solid-workbench/chat/__tests__/issue267.mathCache.test.ts` | **恢复 #272 会话未提交的删除**并改导入指向 `../mathMarkup.ts`（测试保留，导入不再拖组件进 React 检查） | 修改 |
| `scripts/check-runtime-boundaries.mts` | `DIRECT_INVOKE_ALLOWLIST` 登记 `src/app/startupTiming.ts`（#269 观测旁路叶子模块，hookBridgeDispatcher 先例形态；该直发在 CI 前序红修复后会暴露） | 修改 |

## 验收结果

| 项 | 结果 |
| --- | --- |
| `tsc -b --force` 全量重建 | 0 错误（修复前 CI 3 错误） |
| `bunx eslint src/`（CI lint 口径） | 0 error（1 条既有 warning，基线内） |
| `check:solid` | 全绿（边界 allowlist 登记 + 渲染器类型/样式门禁） |
| `bunx vite build` | 通过 |
| vitest 定向（mathCache / mathFootnotes） | 11 用例绿 |
| vitest 全量 | 4808+ 用例零失败（后台跑，计数见 issue 回写） |

## 测试处置

- 恢复 `issue267.mathCache.test.ts`（#272 会话工作树内删除 → 回到仓库并改导入）；3 用例全绿。
- 其余测试零修改。

## 域接管声明

- `mathRender.solid.tsx` / `issue267.mathCache.test.ts` 属 #267/#272 会话文件域：本轮为修 CI 接管，改动限于「拆分纯模块 + 恢复测试 + 改导入」，**渲染行为与缓存语义零变化**；#272 工作树内未提交的测试删除被本修复替代（测试保住而非删除）。
- `check-runtime-boundaries.mts` allowlist 一行系 #269 的必要跟进（该直发在 #269 落地时未被 CI 观察到——后续 CI run 被 mathRender 挡在更早步骤）。

## 未解问题

- #272 会话若对 mathCache 测试删除另有意图（如缓存语义计划变更），请在本记录评论/issue 对表。
