# Dev Record — #412 聊天内容列水平居中

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/412
- 分支：`codex/chat-centering-412`
- 基准：`9f0213be`（`github/main`）
- 代码与说明书提交：`abffdcc7`
- 日期：2026-09-28
- 施工署名：Codex

## 目标与范围

限宽正文、Markdown 与独立活动卡在聊天面板内水平居中，左右留白相等；内容本身仍从左侧开始排版。侧栏折叠只改变面板可用宽度。保留全宽用户消息条、气泡态用户消息的对齐、嵌套活动的层级缩进与现有交互。用户本次指定浏览器验收，不做 Tauri/WebView2 真机验收。

## 改动清单

| 文件 | 区段 | 性质 |
| --- | --- | --- |
| `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css` | 内容槽、助手标记列、活动卡 | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | Workbench 显示层说明 | 修改 |

## 方案要点

- `.solid-content-kind` 继续从外观系统取得 `maxWidth`，用 `margin-inline:auto` 在消息行内居中；用户消息条内的内容槽保持左侧锚定。
- 带标记助手行的正文轨右侧增加与左侧标记列等宽的空间；Claude 布局无标记助手行也补齐右侧空间。这样 Suite 内容与 fallback Markdown 的盒子都相对完整消息行居中，内部文字没有改为居中对齐；气泡模式不消费这两条补偿。
- 工具卡、工具组、进程卡、顶层子代理卡与工作流卡不经过 `.solid-content-kind`，在各自现有宽度限制下加自动左右边距。深层活动保留按深度偏移的树形语义；没有改动侧栏状态、内容宽度设置或工具连接线的测量逻辑。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 限宽块左右留白差 ≤2px | Edge 隔离几何页：正文 760px 在 1260px 面板内为 218/218px；960px 工具/工具组/进程/顶层活动卡为 118/118px。带标记正文也是 218/218px。 |
| 左右栏分别折叠后仍对称 | Edge 实际 Solid 富内容页（左栏 240px、右栏 300px 的浏览器外壳）：助手正文与工具卡在双栏展开、仅左折叠、仅右折叠、双栏折叠时左右差均为 0px。工具卡对应留白为 118/118、238/238、268/268、388/388px。 |
| 窄宽度不水平偏移 | 1128px 外壳、588px 聊天面板：工具卡 0/0px 铺满可用行宽；助手正文因标记列左右各留 18.8px。 |
| 文字和用户消息原有语义 | 浏览器 `getComputedStyle(...).textAlign` 为 `start`；用户消息仍贴左侧。气泡态用户行相对内容盒右边缘间隙为 0px。 |

## 测试处置

- 修改或删除既有测试：无。
- `ChatView.css.test.ts` 原有 31 项全过；本次几何差值用 Edge 的 `getBoundingClientRect()` 在真实 CSS 与 Solid 富内容浏览器页面中验证。临时验收页和脚本位于忽略目录，未入库。

## 证据

- `bun run test src/renderers/solid-workbench/chat/__tests__/ChatView.css.test.ts`：1 文件、31 用例通过，exit 0。
- `bun run lint`：0 error、1 条既有 `GatewaySheetView.tsx:193` warning，exit 0。
- `bun run check:first-party-styles`：23 个 CSS 文件检查通过，exit 0。
- `bun run check:docs`：4 项文档链接检查通过，维护清单无 unmapped 文件，exit 0。
- `bun run build`：TypeScript 和 Vite 构建通过，4667 模块转换，exit 0。
- `bun run check:clippy`：6 个 crate 的 `added: []`，exit 0。首次执行因独立工作树缺少 `dist/` 而被 `tauri::generate_context!` 阻断；执行前端构建后重跑通过。
- 浏览器：本机 Edge headless 加载 Vite 的 `solid-rich-qa` 渲染器，按上述五种外壳宽度/折叠组合读取 DOM 盒子；另以同一 `ChatView.css` 的隔离页面覆盖 Suite 内容槽、工具组、进程与顶层活动卡。Rich QA 页面走 fallback Markdown，Suite 的 `solid-content-kind` 由隔离页面覆盖；未运行 WebView2。

## 与 spec 的偏差

- 原 spec 只要求内容槽与按需的工具卡；浏览器基线发现进程/顶层活动卡同样左锚，并发现助手标记列使正文偏右约 25.6px，故一并修正。
- 原 spec 提议真机验收；按用户本次明确要求改为浏览器验收。

## 未解问题

- 深层子代理/工作流卡保留层级缩进，因此不以整张卡左右留白相等作为判据。

## 并行交集

共享工作树曾有 #410 样式与 #412 草稿未提交；本次在独立工作树从 `github/main` 施工并提交，没有带入 #410 文件改动。
