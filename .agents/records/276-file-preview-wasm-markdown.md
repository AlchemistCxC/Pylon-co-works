# Dev Record — #276 FileTabView markdown 预览摘除 react-markdown

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/276
- 分支：`kumo/prometheus`
- 提交范围：`e0414dbd..`（本 PR）
- 日期：2026-09-24

## 目标与范围

markdown 解析全仓收敛到 wasm 计算核（comrak）单一实现：把最后一处 react-markdown 消费点
（FileTabView 的 markdown 文件预览）改为消费 `parseMarkdown()` 渲染模型，删除
`markdownLazy.tsx` 与 react-markdown / remark-gfm / remark-parse / remark-rehype / unified 依赖。

不做：Solid 侧渲染/缓存/流式任何改动；wasm/Rust 出口任何改动；渲染增强（表格居中、rehype-raw）；
CSS 改动。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/infrastructure/compute/markdownCompute.ts` | 新增 `MarkdownModelRoot/Element/Text/Node` 类型导出（Rust serde JSON 的 TS 投影，形状由 parity 快照钉死）；`parseMarkdown` 返回类型**保持 `unknown`** | 修改（纯类型面） |
| `src/sheets/file/MarkdownPreview.tsx` | React 侧渲染模型→JSX 通用投影组件（装载态/失败态/非受控表单字段投影/`\n` 容器分隔符剔除） | 新增 |
| `src/sheets/file/FileTabView.tsx` | markdown 预览段换用 `MarkdownPreview`；删 `markdownLazy` import 与 Suspense；头注释同步 | 修改 |
| `src/components/chat/markdownLazy.tsx` | react-markdown lazy 包装 | 删除 |
| `src/sheets/file/__tests__/MarkdownPreview.test.tsx` | 6 用例（标题段落/表格 align/任务列表非受控/脚注属性连字符化/代码块语言类/链接图片） | 新增 |
| `package.json` / `bun.lock` | 移除 `react-markdown`、`remark-gfm`、`remark-parse`、`remark-rehype`、`unified`、`hast-util-to-html` | 修改 |

## 方案要点

1. **返回类型保持 `unknown`（偏离 spec 的收窄意图）**：parity 测试对出口返回值做宽松 JSON
   断言转型，强类型返回会迫使改既有测试（违背 refactor「既有测试未修改」判据）；且 solid 侧
   `normalizeRoot` 的姿态就是「过界值不信、消费方自归一」。类型契约导出留给消费方显式
   cast（React 侧）/归一（Solid 侧），出口不假装已验证。
2. **通用投影而非逐标签特判**：文件预览没有聊天路径的 term-* 表现层（原 react-markdown
   路径同样没有），`.file-tab-md` 容器样式消费裸元素流。hast 属性名→React 属性名三条规则：
   `className` 数组拍平；`aria*`/`data*` camelCase 连字符小写化（否则 React 会丢中段，
   实测 `dataFootnoteRef` → `datafootnoteref`）；`checked`/`value` 投影为非受控
   （`defaultChecked`/`defaultValue`，否则 React 受控告警撞测试白名单硬断言）。
3. **`\n` 容器分隔符剔除**：comrak 的容器排版（parser.rs）在 blockquote/ul/ol/table 家族
   子级插入 `"\n"` 分隔文本节点；React 对 table 家族容器内的纯空白文本节点发 dev 告警。
   投影时剔除 `value === '\n'` 的文本节点（段内软换行在文本 value 内部，不受影响）。
4. **`hast-util-to-html` 一并移除（超出 spec 声明的第六个依赖）**：全仓零源码 import，
   仅剩一条注释提及——同属 markdown 栈死依赖，归入本 issue 类别。
5. **失败路径**：wasm 装载/解析失败 → `reportRuntimeError('渲染 Markdown', …)` 上报 +
   组件内失败态文案；不吞错、不静默降级（对齐 `markdownCompute.ts` 装载层纪律）。

## 已知渲染形状收敛差异（相对 react-markdown 路径，方向均为「与聊天主链路一致」）

- 数学公式：原路径不解析、`$$x$$` 原样文本；现按 comrak 模型渲染 `span.math`/`div.math`
  含 latex 文本（文件预览无 MathRender 表现层，显示 latex 原文）。
- 脚注/任务列表/表格 align：走 comrak 模型（#267/#272 已与 remark-gfm 形状对齐），
  测试逐项锁定。
- raw HTML：comrak `unsafe_=false` 与 remark-rehype 默认同为弃置，parity 快照为准。

## 验收标准与结果

- [x] 既有行为测试全绿且未被修改：全量 `vitest run` **637 文件 / 4825 用例通过**（1 skipped / 1 todo）
- [x] 门禁：`tsc -b` 绿；`eslint src/` 0 error（唯一 warning 在 Codex-Aster 在途域
      `RightRailHost.tsx`，非本 issue 文件）；`vite build` ✓；`check:bundle` PASS
      （js gzip 1,487,923 / budget 1,615,000；wasm gzip 206,292 / budget 230,000）；`check:deps` PASS
- [x] 结构目标达成：`grep react-markdown src` 零命中；六依赖出表；`markdownLazy.tsx` 删除
- [x] 未新增白名单豁免（vitest.setup 白名单零改动）
- [x] Solid 侧 / 首方 CSS diff 为零（`git diff` 核对）
- [x] `docs/说明书/` 无 react-markdown / file sheet markdown 预览表述，零漂移，无需同步

## 遗留与未解

- `markdownRenderModel.ts`（Solid 侧）与 `markdownCompute.ts` 各有一份渲染模型 TS 类型，
  结构同义、parity 快照锁住——后续若做单源收敛，宜把共享类型落到 `infrastructure/compute/`
  并让 Solid 侧 re-export，本轮不动（零改动承诺）。
- 文件预览的代码块无高亮（原 react-markdown 路径同样没有），如需高亮属功能增强另立 issue。
