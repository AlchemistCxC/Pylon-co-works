# Coder-A 交接记录

> 当前状态：尚未开始本组业务任务。
> B-01 sanitizer 已由主协调者完成，B-02/B-03 待本组接管。

## 接管前动作

```bash
cd /g/Project/prism-desktop
git status --short --branch
git log -5 --oneline
git diff -- src scripts docs
git diff --cached
```

## 当前入口

1. 阅读 `01-Coder-A-Chat与Session.md`。
2. 先执行 B-02，确认 `htmlSanitizer.ts` 和 `test-html-sanitizer.mts` 当前内容。
3. 只修改 `ChatView.tsx` 与 B-02 指定测试。
4. 完成 B-02 后再开始 B-03；两个任务不能同时修改 `ChatView.tsx`。
5. 每项完成后将真实结果追加到本文件。

# A-B02 Starry Night sink 接入

## 1. 单一目标

将 `CodeBlock` 的 Starry Night 高亮 HTML 在进入 `dangerouslySetInnerHTML` 前统一经过 `sanitizeHtml`；fallback 纯文本路径保持不变。

## 2. 当前基线

```text
项目：G:\Project\prism-desktop
分支：main
HEAD：ca83eb9 fix(agent): 完善 Agent 状态生命周期
开始时 git status --short：存在用户/其他 coder 的前端、后端和文档改动；本任务未清理、恢复或提交这些资产。
```

外部工作区资产包括：`src-tauri/` 修改和未跟踪文件、根目录既有文档删除、前端交接/任务文档、其他测试脚本和 `package.json` 修改。`htmlSanitizer.ts` 与 `test-html-sanitizer.mts` 为此前已有的 B-01 资产，本任务未重建或扩大 sanitizer。

## 3. 允许范围

### 允许读取

`ChatView.tsx` 的 `CodeBlock`、`codeHighlight.ts`、`htmlSanitizer.ts`、`test-code-highlight.mts`、项目构建配置。

### 允许修改

```text
src/components/chat/ChatView.tsx
scripts/test-chat-sanitizer-sink.mts
```

### 禁止读取/修改

`src-tauri/`、`src/store.ts`、Settings/Preview/RightPanel、`package.json`、其他 coder 文件和 B-03 以外的业务区域。

## 4. 修改文件及职责

| 文件 | 修改符号/区域 | 职责 |
|---|---|---|
| `src/components/chat/ChatView.tsx` | import、`CodeBlock.renderLines` | 接入 sanitizer 到 Starry Night 唯一 HTML sink |
| `scripts/test-chat-sanitizer-sink.mts` | 新增结构回归 | 防止 sanitizer import 或 sink 前置调用被移除，并确认 Anser sink 留给 B-03 |

## 5. 根因与触发条件

多行代码块高亮成功后，`highlighted.html` 直接进入 `dangerouslySetInnerHTML`。虽然 Starry Night 当前主要生成受控高亮 HTML，但 sink 边界没有统一白名单清洗，后续代码内容或高亮输出变化可能绕过既有安全边界。

修复后，Starry Night HTML 先经过 B-01 的受限 `sanitizeHtml`，仅保留允许的标签、属性和 `pl-*`/`term-*` class；未知语言、加载失败和单行代码仍走原有 React 文本节点路径。

## 6. 状态与数据作用域

本任务只涉及渲染瞬时 HTML，不新增 global/profile/session/source/periId 状态，也不改变消息持久化和 ACP 事件路由。

```text
Session.id → Session.source → Session.periId
```

该链路在本任务中未修改。

## 7. API/Event 契约

无新增 command/event，无后端改动。`sanitizeHtml` 是已有前端纯函数；Starry Night 输出格式来自现有 `highlightCode`，本任务未扩大其语言或 HTML 白名单。

## 8. 持久化与迁移

无 localStorage、Zustand persist 或 schema 变更。

## 9. 实现不变量

- Starry Night HTML 进入 `dangerouslySetInnerHTML` 前必须调用 `sanitizeHtml`。
- fallback 文本路径不新增 HTML sink。
- `pl-*` 高亮 class 由既有 sanitizer 白名单保留。
- 不扩大 sanitizer 标签、属性或 class 白名单。
- 本任务不接入 Anser sink；Anser 仍是 A-B03 的独立任务。

## 10. 验证命令与真实结果

```text
专项测试：node --experimental-strip-types scripts/test-code-highlight.mts
结果：通过，exit code 0；输出：codeHighlight 回归测试通过

专项测试：node --experimental-strip-types scripts/test-chat-sanitizer-sink.mts
结果：通过，exit code 0；输出：ChatView Starry Night sanitizer sink 回归测试通过

Build：npm run build
结果：通过，exit code 0；tsc -b 与 vite build 均成功。
warning：既有动态/静态 dialog import 分包 warning；既有大 chunk warning，均未阻断 build。

Diff check：待交接文档 patch 后执行最终新鲜验证。
```

## 11. 浏览器/Tauri 后置验收

未执行，属于后置验收。需要在浏览器 dev server 中打开真实代码块，记录 DOM sink 渲染结果，验证高亮 class、空行、中文/英文和恶意片段显示；真实 Tauri/ACP 不在本任务范围内，不能用 Node 测试替代。

## 12. 剩余风险与 blocked

- `dangerouslySetInnerHTML` 的 Anser 输出仍未经过 sanitizer，留给 A-B03，不能将本任务描述为 Chat 全部 sink 已安全。
- 浏览器和真实 Tauri 视觉/运行时验收尚未执行。
- 本任务未验证后端契约，因为没有新增跨端调用。

## 13. 工作区与提交

```text
本任务修改：src/components/chat/ChatView.tsx、scripts/test-chat-sanitizer-sink.mts
其他 coder 修改：存在，保持原样
用户既有修改：存在，保持原样
是否 commit：否，交由主协调者处理
```

## 14. 下一步

1. 主协调者复核限定 diff，不要将 `src-tauri/`、package.json、其他 coder 文件纳入本任务。
2. 进入 A-B03 前确认 B-02 diff 已复核；只修改 Anser sink 相关区域。
3. 为 Anser 输出调用 `sanitizeHtml`，保留 `Anser.escapeForHtml`，新增 `scripts/test-chat-anser-sink.mts`。
4. B-03 完成后重新运行两项 Chat sanitizer 测试、`npm run build` 和限定路径 `git diff --check`。

# A-B03 Anser sink 接入

## 1. 单一目标

将 Bash ToolCard 的 Anser ANSI HTML 在进入 `dangerouslySetInnerHTML` 前经过既有受限 `sanitizeHtml`；非 Bash 输出继续使用 React 文本节点。

## 2. 当前基线

```text
项目：G:\Project\prism-desktop
分支：main
HEAD：ca83eb9 fix(agent): 完善 Agent 状态生命周期
开始时 git status --short：存在用户/其他 coder 的前端、后端和文档改动；本任务未清理、恢复或提交这些资产。
```

A-B02 对 `ChatView.tsx` 和其测试的未提交修改属于本组前置资产，本任务在其上继续修改；其他 `src-tauri/`、package、文档和 coder 文件保持原样。

## 3. 允许范围

### 允许读取

`ChatView.tsx` 的 `ToolCard`、`htmlSanitizer.ts`、`anser` 现有 API/类型和 B-02 测试。

### 允许修改

```text
src/components/chat/ChatView.tsx
scripts/test-chat-anser-sink.mts
docs/前端分组开发/Coder-A-交接记录.md
```

### 禁止读取/修改

`src-tauri/`、`src/store.ts`、Settings/Preview/RightPanel、`package.json`、其他 coder 文件和 A-C 任务。

## 4. 修改文件及职责

| 文件 | 修改符号/区域 | 职责 |
|---|---|---|
| `src/components/chat/ChatView.tsx` | `ToolCard.outputHtml` | 保留 Anser 输入转义，并将 ANSI HTML 送入 sanitizer |
| `scripts/test-chat-anser-sink.mts` | 新增结构回归 | 验证 Anser sink 清洗、非 Bash 文本路径和 escape 保留 |
| `docs/前端分组开发/Coder-A-交接记录.md` | 本章节 | 记录任务边界、契约和验证证据 |

## 5. 根因与触发条件

Bash tool output 使用 `Anser.escapeForHtml` 后调用 `ansiToHtml`，返回 HTML 直接进入 `dangerouslySetInnerHTML`。`escapeForHtml` 只负责输入转义，不是对 Anser 生成结果的 HTML 白名单 sanitizer；Anser 默认还会生成 inline `style` 属性，而当前 sanitizer 明确删除 `style`，因此必须把 sanitizer 放在 ANSI 转换之后作为第二道边界。

实现后链路为：

```text
Bash output → Anser.escapeForHtml → Anser.ansiToHtml → sanitizeHtml → dangerouslySetInnerHTML
```

已确认的 Anser 实际输出包含 `style="color:..."`；当前 sanitizer 会安全删除该属性，文本仍保留。没有擅自扩大 sanitizer 白名单，也没有把 `style` 改成允许属性。

## 6. 状态与数据作用域

本任务只涉及 ToolCard 渲染派生值 `outputHtml`，不新增状态，不修改消息、session、source 或生成状态。

```text
Session.id → Session.source → Session.periId
```

该链路在本任务中未修改。

## 7. API/Event 契约

无新增 command/event，无后端改动。Anser 运行时 API 证据来自已安装 `anser` 包的 README/type definition：`ansiToHtml(text, options?)` 返回 HTML 字符串；本任务继续使用默认 options，不改变 ANSI 颜色协议。HTML 安全边界由前端已有 `sanitizeHtml` 提供。

## 8. 持久化与迁移

无 localStorage、Zustand persist 或 schema 变更。

## 9. 实现不变量

- `Anser.escapeForHtml` 必须继续执行。
- `ansiToHtml` 的结果必须先经过 `sanitizeHtml`，再进入 HTML sink。
- 非 Bash tool output 不进入 HTML sink，继续使用 `<pre><code>{output}</code></pre>` 文本节点。
- 不扩大 sanitizer 的标签、属性或 class 白名单。
- 本任务不改 ANSI 显示设计；由于当前白名单不允许 inline style，颜色视觉结果属于浏览器后置验收风险，不得写成已保留颜色。

## 10. 验证命令与真实结果

```text
专项测试：node --experimental-strip-types scripts/test-code-highlight.mts
结果：通过，exit code 0；输出：codeHighlight 回归测试通过

专项测试：node --experimental-strip-types scripts/test-chat-sanitizer-sink.mts
结果：通过，exit code 0；输出：ChatView Starry Night sanitizer sink 回归测试通过

专项测试：node --experimental-strip-types scripts/test-chat-anser-sink.mts
结果：通过，exit code 0；输出：ChatView Anser sanitizer sink 回归测试通过

专项测试：node --experimental-strip-types scripts/test-html-sanitizer.mts
结果：通过，exit code 0；输出：html sanitizer tests passed

Build：npm run build
结果：通过，exit code 0；tsc -b 与 vite build 均成功。
warning：既有动态/静态 dialog import 分包 warning；既有大 chunk warning，均未阻断 build。

Diff check：本任务源码和测试限定路径通过，exit code 0。
```

## 11. 浏览器/Tauri 后置验收

未执行，属于后置浏览器验收。需要展开 Bash mock，记录 DOM 中 `.term-ansi` 内容，确认危险 HTML 不执行、ANSI 文本/换行稳定；还需实际确认颜色是否符合产品要求，因为当前 sanitizer 会移除 Anser 的 inline style。真实 Tauri/ACP 不在本任务范围内。

## 12. 剩余风险与 blocked

- 当前 sanitizer 白名单不包含 `style`，Anser 默认颜色 style 会被删除；这是安全策略的可见性影响，不能未经产品/安全决策扩大白名单。
- 浏览器/Tauri 未执行。
- 没有新增后端契约，跨端验收不适用。

## 13. 工作区与提交

```text
本任务修改：src/components/chat/ChatView.tsx、scripts/test-chat-anser-sink.mts、docs/前端分组开发/Coder-A-交接记录.md
其他 coder 修改：存在，保持原样
用户既有修改：存在，保持原样
是否 commit：已由主协调者提交 A-B02；本章节对应 A-B03 尚未单独提交，交由主协调者处理，确认没有纳入其他 coder 或 `src-tauri/` 改动。
```

## 14. 下一步

1. 主协调者复核 B-02/B-03 限定 diff。
2. 产品/安全负责人决定是否为 Anser 设计安全 class 映射；在决策前不扩大 `sanitizeHtml` 白名单。
3. 后置浏览器验收记录 `.term-ansi` 的危险片段、换行和颜色 DOM 证据。
4. 进入 A-C01D 前，保持 `ChatView.tsx` 任务串行，先完成 B-03 的最终验证。

# A-C01D clear 持久化清除

## 1. 单一目标

`peri:clear` 清空当前会话内存消息、当前显示消息和所属 `pylon-msgs-${session.id}` localStorage 缓存，reload 后不恢复旧消息。

## 2. 当前基线

```text
项目：G:\Project\prism-desktop
分支：main
HEAD：a2cef58 fix(chat): 清洗 Starry Night 高亮 HTML sink
开始时 git status --short：A-B03、其他 coder、用户和后端均有未提交工作区资产；未清理或覆盖。
```

A-B02 已由主协调者单独提交；A-B03 未提交修改在本轮工作区中继续保留。共享 `ChatView.tsx` 的本任务只修改 clear 事务与消息持久化调用，不改 UI 设计或其他 session 逻辑。

## 3. 允许范围

### 允许读取

`ChatView.tsx` 的 session owner、消息缓存和 `peri:clear` listener；`InputBar.tsx` 的 `/clear` 触发点；`messagePersistence.ts`。

### 允许修改

```text
src/components/chat/ChatView.tsx
src/components/chat/messagePersistence.ts
scripts/test-message-persistence-clear.mts
scripts/test-chat-clear-sink.mts
docs/前端分组开发/Coder-A-交接记录.md
```

### 禁止读取/修改

`src-tauri/`、`src/store.ts`、Settings/Preview/RightPanel、`package.json`、其他 coder 文件和 A-C01A/B/C/E/F/G 任务。

## 4. 修改文件及职责

| 文件 | 修改符号/区域 | 职责 |
|---|---|---|
| `src/components/chat/ChatView.tsx` | `handleClear`、消息 storage 调用 | 校验 owner/source 后同步清内存、UI 和 localStorage |
| `src/components/chat/messagePersistence.ts` | storage key/clear 纯函数 | 集中消息 key 和删除动作，避免 clear 漏删或拼接漂移 |
| `scripts/test-message-persistence-clear.mts` | 纯函数测试 | 验证 key 和 removeItem 行为 |
| `scripts/test-chat-clear-sink.mts` | 结构回归 | 验证 clear listener 绑定当前 session owner/source |
| `docs/前端分组开发/Coder-A-交接记录.md` | 本章节 | 记录状态、验证和后置验收 |

## 5. 根因与触发条件

`InputBar` 的 `/clear` 只派发 `peri:clear`，原 `ChatView.handleClear` 仅将 `messagesBySourceRef` 当前 source 设为空并清空 React state，没有删除 `pylon-msgs-${session.id}`。用户执行 `/clear` 后 reload，会重新从 localStorage 恢复旧消息，违反清屏语义。

修复后先同时确认 `messageOwnerRef.current` 和 `sessionRef.current`，再通过 `sessions` 精确匹配 `id + source`。匹配失败直接返回，不会删除其他 session 的缓存。

## 6. 状态与数据作用域

```text
Session.id → Session.source → Session.periId
```

- localStorage key 作用域：`pylon-msgs-${Session.id}`。
- 内存消息 cache 作用域：`messagesBySourceRef.current[Session.source]`。
- 当前 React 显示作用域：owner/source 与当前 render session 一致。
- 本任务不修改 `periId`、generation、live generating 或后端 session。

## 7. API/Event 契约

`peri:clear` 是前端 `CustomEvent`，由 `InputBar` `/clear` 派发；本任务没有新增后端 command/event，也没有修改事件 payload。契约只确认前端现有调用链，真实后端清理行为未确认/不在本任务中。

## 8. 持久化与迁移

- key：`pylon-msgs-${session.id}`。
- 无 schema version 变更。
- clear 使用 `removeItem`，不写入空数组。
- reload 时不存在缓存，ChatView 使用空消息数组。
- 删除 localStorage 失败时，当前内存和 UI 仍清空；Storage 异常未向用户抛出，属于现有 best-effort persistence 语义。

## 9. 实现不变量

- clear 必须按 `Session.id + Session.source` 双重 owner 校验。
- 不能使用当前 render 的 `sessionId` 直接拼成未知对象的 key。
- 内存、React state、localStorage 三者清除动作必须在同一 clear handler 中完成。
- 空消息不得通过 `setItem` 写回旧数组或空数组。
- 不影响后台其他 source 的消息 cache。

## 10. 验证命令与真实结果

```text
专项测试：node --experimental-strip-types scripts/test-message-persistence-clear.mts
结果：通过，exit code 0；输出：消息持久化清除回归测试通过

专项测试：node --experimental-strip-types scripts/test-chat-clear-sink.mts
结果：通过，exit code 0；输出：ChatView clear 持久化接入回归测试通过

专项测试：node --experimental-strip-types scripts/test-chat-anser-sink.mts
结果：通过，exit code 0；输出：ChatView Anser sanitizer sink 回归测试通过

专项测试：node --experimental-strip-types scripts/test-chat-sanitizer-sink.mts
结果：通过，exit code 0；输出：ChatView Starry Night sanitizer sink 回归测试通过

专项测试：node --experimental-strip-types scripts/test-html-sanitizer.mts
结果：通过，exit code 0；输出：html sanitizer tests passed

Build：npm run build
结果：通过，exit code 0；tsc -b 与 vite build 均成功。
warning：既有动态/静态 dialog import 分包 warning；既有大 chunk warning，均未阻断 build。

Diff check：本任务限定源码、测试和交接文档路径通过，exit code 0。
```

## 11. 浏览器/Tauri 后置验收

未执行，属于后置浏览器验收。需要在浏览器 dev server 中创建/加载一个可显示消息的 session，执行 `/clear`，记录 `localStorage.getItem('pylon-msgs-<id>') === null`、DOM 消息为空，再 reload 验证不恢复。真实 Tauri/ACP 不需要新增契约，但仍需确认运行时输入 command 路径。

## 12. 剩余风险与 blocked

- 本任务未运行真实浏览器/Tauri。
- localStorage 的异常删除路径只保留现有 best-effort 行为，未新增错误浮层。
- A-C01A/B/C/E/F/G replay 事务尚未处理，不能将本任务描述为完整 Session 闭环完成。

## 13. 工作区与提交

```text
本任务修改：src/components/chat/ChatView.tsx、src/components/chat/messagePersistence.ts、scripts/test-message-persistence-clear.mts、scripts/test-chat-clear-sink.mts、docs/前端分组开发/Coder-A-交接记录.md
其他 coder 修改：存在，保持原样
用户既有修改：存在，保持原样
是否 commit：否，交由主协调者处理
```

## 14. 下一步

1. 主协调者先复核 A-B03 与 A-C01D 的共享 `ChatView.tsx` 混合 diff。
2. 只提交 A-B03/A-C01D 明确文件和对应 hunk，不纳入 `src-tauri/`、package 或其他 coder 文件。
3. 后置浏览器验证 `/clear` 后 localStorage 删除、DOM 清空和 reload 不恢复。
4. 下一项进入 A-C01A replay buffer 收敛，保持每个 replay 根因独立提交。
