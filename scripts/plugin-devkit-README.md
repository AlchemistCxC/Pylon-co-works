# Pylon 插件开发套件（离线包）

不动源码仓库、不装构建工具链，也能从零写出并安装一个 Pylon 插件。
本套件自包含：SDK、起步示例、说明书、自检脚本都在包内。

前置条件：一台已安装 **Pylon ≥ 1.4.1** 的机器（插件最终在 Pylon 里启用和验证）。

## 30 秒路径（纯 JS，零工具链）

1. 复制 `starter/no-build/` 为你的插件目录（改个目录名即可）；
2. 改 `pylon-plugin.json` 的 `id` / `name`（id 全局唯一，建议 `作者.插件名`）；
3. 编辑 `index.js`——`activate` 里已经演示了命令、Hook、存储、设置页四个面；
4. Pylon「设置 → 插件」→ 安装目录 → 启用。

不需要 Node，不需要打包器：入口是纯 ESM，`import './pylon-plugin-sdk.js'` 相对引用随包 SDK。

## TypeScript 路径（starter/typescript）

- 需要自备 Node ≥ 18；
- `src/index.ts` 用 `import ... from '@pylon/plugin-sdk'`（类型由 `sdk/types/` 提供）；
- `npm install`（装 esbuild）→ `npm run build` → 安装 `dist/` 所在目录；
- 不想装 esbuild 也行：包内 `dist/index.js` 是预构建产物，直接安装即可。

两种 starter 的源码即文档：五个最常用面（命令 / Hook / 会话元数据 / Scope 纪律 / 隔离设置页）各有一段带注释的最小代码。

## 套件结构

| 路径 | 内容 |
| --- | --- |
| `sdk/pylon-plugin-sdk.js` | SDK 运行时（单文件 ESM；无构建路径的直接 import 目标） |
| `sdk/testing.js` | 测试基建（`createMockContext` 等，见 §6.11.1） |
| `sdk/types/` | 完整类型声明树（TS 作者编辑器补全） |
| `sdk/pylon-plugin-manifest.schema.json` | `pylon-plugin.json` 校验/补全 schema |
| `starter/no-build/` | 纯 JS 起步插件 |
| `starter/typescript/` | TS + esbuild 起步插件（含预构建产物） |
| `docs/` | 开发者版 / 用户版说明书、CLI 命令表、设置选项贡献 |
| `verify.mjs` | 自检：结构完整性 + SDK 导出 + 类型探针（需 Node ≥ 18） |

自检：`node verify.mjs`（可选；通过会打印 PASS 清单）。

## 测试你的插件（可选，需要 Node）

```bash
npm i -D vitest
```

```ts
// my-plugin.test.ts
import { definePlugin } from '@pylon/plugin-sdk'
import { createMockContext } from '@pylon/plugin-sdk/testing'

const ctx = createMockContext({ pluginId: 'my.plugin' })
const plugin = definePlugin({ /* 你的 activate */ })
await plugin.activate(ctx)
await ctx.__commands.execute('your.command.id', { /* args */ })
```

测试基建使用说明见 `docs/Pylon-插件系统说明书-开发者版.md` §6.11.1。

## 契约速查

- 清单：`schema: 1`、`api: "1.0" | "1.1"`（1.1 才有 `context.storage`）、kind 十选一；
- 生命周期：`activate` / `deactivate`（可选 `prepare` / `suspend` / `resume`）；
- 所有副作用（定时器 / 事件监听）走 `context.scope.*`，停用时自动回收；
- 样式：选择器以插件前缀类名限定，颜色间距用宿主语义 token（§6.4.2）；
- 只安装来源可信的插件——插件是本机受信代码，宿主不做恶意代码沙箱。

完整契约（16 章）见 `docs/Pylon-插件系统说明书-开发者版.md`；SDK 用法集中在 §6.11。
