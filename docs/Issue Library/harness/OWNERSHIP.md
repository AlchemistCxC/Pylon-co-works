# 文件所有权与共享边界

所有权是默认值，任务卡可进一步缩小，但不能静默扩大。

## A 默认所有权

- `src-tauri/**`
- `src/application/**`
- `src/infrastructure/**`
- `src/domains/**` 中非纯视觉领域逻辑
- `src/store.ts`、`src/runtimeStore.ts`、`src/workspaceStore.ts` 等全局状态
- `src/workspace-sheets/**` 的 registry、layout contract 和路由骨架
- `scripts/test-*.mts`、Rust tests、构建与发布脚本
- 数据 schema、IPC command/event、权限与安全边界

## B 默认所有权

仅在任务卡显式列入后可修改：

- 新增的 `src/effects/**`、`src/immersive/**`、`src/particles/**`
- 组件局部 animation、transition、visual state
- 动效专用 CSS module/样式文件、素材清单、视觉 token proposal
- 沉浸模式的 scene composition，但不直接改业务状态和 IPC

当前仓库未必已有上述目录；创建目录也必须写入任务卡 scope。

## 共享边界

以下改动必须走契约冻结：

- `src/App.tsx`、`src/App.css`、`src/index.css`
- `src/workspace-sheets/**` 公共布局与 registry
- 公共组件 props、DOM 结构、稳定 selector、ARIA contract
- 主题变量、尺寸 token、z-index、portal root、overlay 层级
- Zustand store shape、持久化 key/version
- Tauri command/event DTO
- Vite/package 依赖、构建配置、资源加载策略

## 永久禁止自动修改

- `.env*`、凭据、密钥、签名材料
- `.git/**`
- `docs/archive/**`
- `src-tauri/target/**`、`node_modules/**`、`dist/**`
- 与任务无关的发布产物和截图

## do_not_modify 机制

任务卡同时声明：

- `scope.allow`：可改 glob。
- `scope.deny`：即使被 allow 覆盖也禁止。
- `scope.read_only`：允许阅读但不得修改。
- `shared_touchpoints`：可能触碰的共享文件；必须引用 frozen contract id。

验证脚本根据 `git diff --name-only <base>...HEAD` 检查越界；发现越界时任务不得进入 review。
