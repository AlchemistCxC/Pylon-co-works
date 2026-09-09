# 蓝调战术：可选界面与验收

在标题栏「界面」选择「蓝调战术」。通过「打开 Sheet → Overview」进入指挥台；也可执行内置命令 `interface.tactical-blue.activate`。默认界面仍是现代 GUI，原有 Terminal-like 不变。

首页依实际状态接入 Agent、进入工作台或继续最近会话；编队、档案、工作区、配置和诊断均复用现有功能。场景设置在首页右下角，可选择两张用户提供的背景、调整强度、关闭背景视差与缓动。偏好独立存储在 `pylon-tactical-scene-v1`。系统减少动态效果设置优先。

## 验证记录（2026-09-10）

基线：main `3127ee4336b30c3f349fd7fe6cb2b69923c4ef3e`。Windows、Node 22.20.0、Rust/Cargo 1.98.1 MSVC。只修改本可选 UI、注册入口及相应测试，无 Rust 业务修改。

- TypeScript 与生产前端构建通过；最终原生可执行文件另行构建验证。
- UI 相关 31 项、共享输入/权限传输与组件 52 项通过；CLI 命令清单回归通过。
- 完整前端门禁：32 个文件失败、444 个通过；12 项失败、2856 项通过、96 项跳过。基线 CI 同为32个失败文件、12个失败测试。门禁不是绿色，不能据此合并。
- 原生应用在蓝调战术模式下，通过真实 CLI → 前端服务 → Tauri → 确定性 ACP 进程完成会话创建、消息往返、取消；重启后会话身份保留，先 `session/load` 再继续 `session/prompt` 成功。
- 发现旧有 CLI 权限应答契约错误：前端传 `permission`，后端只接受 `approval`，返回 `[object Object]`，请求仍挂起。此问题单独报告，未混入样式提交。不能据此推断 GUI 权限按钮同样失败。
- 浏览器预览使用项目自带 IPC mock；截图中的 Agent/日志不证明实际供应商连接。原生验证用本目录 fixture，不调用真实模型或工具。

完整视觉验收见项目根目录 `design-qa.md`。本目录 screenshots 是实际浏览器截图，不是效果图。

## 可重复的原生 ACP 检查

`evidence/tactical-acp-fixture.mjs` 是独立 Node 标准库测试 Agent，不执行任何外部工具。创建一个专用 agents.yaml（使用绝对路径），通过只作用于测试进程的 `PYLON_AGENTS_CONFIG` 指向它。不要覆盖日常配置。

```yaml
agents:
  tactical-fixture:
    name: Tactical UI Verification Fixture
    provider: peri
    default: true
    transport: subprocess
    exe: C:/path/to/node.exe
    args:
      - C:/path/to/tactical-acp-fixture.mjs
      - C:/path/to/acp-evidence.jsonl
```

先构建前端与桌面程序，再启动专用测试应用。使用 `pylon-cli help` 获取命令清单，`workspace open agent --agent-id tactical-fixture` 后创建会话。普通消息返回固定 Markdown；含 `wait-for-cancel` 的消息等待取消；含 `permission` 的消息发出 ACP 权限请求。检查权限前设置 `approval set default`，然后 `interaction list`、`interaction respond <requestId> allow-once`，实际请求 ID 从列表读取。重启后沿用本地 sessionId 发送，fixture 会拒绝未先 new/load 的会话，因此恢复成功有可核对的协议证据。

## 素材

两张背景由任务发起者提供并要求在该可选分支使用，文件未修改；不声明其为 Pylon 原创或官方联动授权。本分支保持草稿，未更改主线默认体验。
