# 启动性能调查与优化方案

## 结论

当前启动慢主要有两条链：WebView 首帧前加载的静态 JavaScript 过大，以及首帧之后必须完成的 bootstrap 事务包含多次串行 IPC。它们可以独立优化；先把首帧和“可交互”定义分开，再调整加载顺序，避免为了快而丢失会话恢复或 Agent 状态。

## 已确认的证据

`npm run build`（2026-08-26）显示：

- Vite 转换 4006 个模块，生产构建耗时约 26.6 秒（这是构建时间，不等于用户启动时间，但说明静态依赖规模较大）。
- 主要首方 chunk：`FileViewHost` 约 444 kB、`first-party-pylon-shell` 约 299 kB、`first-party-pylon-renderers` 约 289 kB、`Settings` 约 170 kB（均为未压缩体积）。
- `@tauri-apps/api/core.js` 同时被静态和动态导入，Vite 因此无法将它拆到独立 chunk；构建日志明确列出了 `userDataRepository.ts` 的动态导入与大量静态消费者。
- `src/main.tsx` 静态挂载 Kernel、字体和应用壳；`KernelRoot` 启动内置插件；应用挂载后 `App.tsx` 再依次 hydrate 本地数据、读取 Agent、读取工具字典、读取 Agent 状态并注册 listener。

当前 bootstrap 顺序在 `src/app/bootstrap/bootstrapApplication.ts` 中是有意设计的正确性边界，不能简单删除步骤：本地数据必须先恢复，Agent 列表必须先应用，listener 必须在初始状态快照之后注册。

## 建议的实施顺序

### 阶段 1：先量化

使用现有 OBS-05 冷启动快照（开发构建在 `src/obs05/`）记录以下时间点：

```text
process start → WebView first paint → Kernel starting
→ builtins ready → application mounted → hydrate done
→ agents applied → dictionary done → status snapshot done
→ listener registered → hydration ready
```

每个阶段记录冷启动和热启动各 20 次，报告 p50/p95；不要只看平均值。补充 DevTools Performance trace，区分脚本执行、样式计算、IPC 等待和首次布局。

### 阶段 2：缩短首帧前静态加载

1. 将设置、文件工作台、浏览器、历史和搜索 Sheet 改为按导航懒加载；首屏只保留 Shell、Sidebar 和 Agent 工作台。
2. 把 CodeMirror/语言包、Starry Night 语言定义和文件预览 provider 从主入口移到打开文件或展开代码块时加载。语言高亮失败已有纯文本回退，可安全延迟。
3. 字体只打包实际使用的子集（当前 `@fontsource/jetbrains-mono/400.css` 和 `700.css` 会带入多个脚本子集）；中文由系统字体回退。
4. 统一 `@tauri-apps/api/core` 的导入策略。推荐保留一个静态 facade，由 facade 内部决定 Tauri/mock transport；不要让同一模块同时出现在静态和动态依赖图中。

### 阶段 3：缩短可交互前 bootstrap

在保持现有依赖顺序的前提下：

1. `hydrateDomains` 完成、`applyAgents` 成功后，并行请求工具字典和 Agent 状态快照；二者互不依赖。
2. listener 注册完成后立即进入 `ready`，把非关键的用户插件扫描/激活移到后台，并在插件状态栏显示“仍在加载”。若某插件提供当前首屏必需的 Agent adapter，则保留其依赖边界。
3. 对工具字典、Profile 和插件清单使用带版本的本地缓存；命中缓存时先渲染，再后台校验远端版本。
4. 对重复挂载（React StrictMode、Kernel soft-remount）复用 bootstrap promise，避免重复 hydrate 和重复 IPC。

### 阶段 4：验证与回滚

每个改动都要通过：

- 首帧不依赖未打开的 Sheet 或语言包；
- 新会话、会话切换、恢复失败和安全模式行为不变；
- 冷启动 p95、首帧 p95、可发送消息 p95 分别记录并与基线比较；
- `npm run check:frontend`、`npm run check:solid`、相关 bootstrap 测试全部通过。

推荐先做阶段 1 和阶段 2 的懒加载实验，再做阶段 3 的并行 IPC。任何把 `ready` 提前的改动都必须保留降级状态和重试入口，不能用隐藏错误换取更快的首屏。
