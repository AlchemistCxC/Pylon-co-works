# Pylon 项目速览 — 给月殇

## 项目简介

Pylon 是 ACP 协议的桌面 GUI 客户端。Tauri v2（Rust 后端 + React 19 前端），通过 stdin/stdout JSON-RPC 连接任意 ACP 兼容 agent。不绑定特定后端——Peri、Hermes 或任何符合 ACP 规范的 agent 均可接入。

仓库：https://github.com/AlchemistCxC/Pylon-co-works

---

## 你的工作范围

`src-tauri/src/gateway/` ——纯新模块，外部平台（QQ/飞书/微信）↔ ACP 桥接层。

**零冲突保证**：这个目录目前不存在，是你独占的。详细分工见 `docs/COWORK.md`。

---

## 核心源文件一览

### 后端（宫木云负责，供你了解接口）

| 文件 | 行数 | 说明 |
|:--|:--|:--|
| `src-tauri/src/lib.rs` | ~565 | Tauri commands（17 个），AppState，会话生命周期 |
| `src-tauri/src/acp.rs` | 313 | `AcpClient`：spawn agent 子进程 + JSON-RPC 通信 |
| `src-tauri/src/agent_config.rs` | 36 | `agents.yaml` 解析，AgentDef 结构体 |
| `src-tauri/src/error.rs` | 73 | `PylonError` 枚举 + `From` impl |
| `src-tauri/src/pet.rs` | 235 | 终端宠物（ASCII 螃蟹），不涉及核心逻辑 |
| `agents.yaml` | 13 | Agent 注册配置 |

### 前端（宫木云负责，供你了解数据结构）

| 文件 | 行数 | 说明 |
|:--|:--|:--|
| `src/App.tsx` | 175 | 根组件，CSS 变量注入，Tab 切换 |
| `src/store.ts` | 236 | Zustand store：ThemeSettings + Session + persist |
| `src/components/chat/ChatView.tsx` | ~520 | 消息渲染 + ACP 事件监听（peri:user/update/done） |
| `src/components/chat/InputBar.tsx` | ~200 | 输入栏：CLI / 默认模式 + 命令面板 |
| `src/components/ControlCenter.tsx` | 557 | 中控区 widget 画布 + PropertyPanel |
| `src/components/Settings.tsx` | 426 | 设置面板 + 实时预览 |

### 你的模块（待创建）

```
src-tauri/src/gateway/
├── mod.rs          # 模块入口，pub 导出各平台
├── qq.rs           # QQ 平台接入
├── feishu.rs       # 飞书平台接入
├── wechat.rs       # 微信平台接入
└── ...

docs/gateway/
├── qq.md
├── feishu.md
└── wechat.md
```

---

## 当前项目状态

### 已完成的最近改动

- 前端预设系统重设计：三套主题（Claude 风格 / Glass Light / Nord Frost）
- ProfileEditor UI 重写：明暗双模适配
- 设置面板背景跟随 uiScheme
- 消息持久化到 localStorage（重启后恢复）
- `session.source` 匹配修复（send/cancel/热键三处统一）

### 已知问题

| # | 问题 | 状态 |
|:--|:--|:--|
| 1 | 发送消息后 token 用量/模型信息不实时更新 | 待查 |
| 2 | 重开会话后 Peri 历史未重放（`load_persisted_session` 已回退到最简） | 需要重新实现 |
| 3 | ChatView 消息持久化后，旧会话恢复时可能和新消息冲突 | 未充分测试 |
| 4 | `send_message` 阻塞 300s 才返回前端，输入框在回复期间无法复用 | 可优化为 fire-and-forget |

---

## Commit 规范

1. **中文** commit message
2. **一个模块一个 commit**，不要混改多个文件
3. Push 前 `cargo check` 通过
4. 直接推 `main` 分支，不用 PR
5. 文件头加署名（见 `docs/COWORK.md` §一）
6. 不要碰 `src-tauri/src/` 下你分区外的文件
7. 需要改共享文件（`lib.rs`、`agents.yaml`、`Cargo.toml`）→ 协作群喊一声

### 好的 commit

```
feat: QQ Gateway 接入，消息收发 + ACP 转换
docs: QQ 平台接入文档
test: QQ 消息→ACP 格式转换测试
```

### 坏的 commit

```
fix various bugs
update
feat: QQ接入 + 前端按钮 + 改lib.rs
```

---

## 技术约定

- Gateway 纯转发——不实现 AI 逻辑
- 协议统一走 `acp.rs` 的 `AcpClient`，不重复造 JSON-RPC
- Agent 注册走 `agents.yaml`
- 文档放 `docs/gateway/`，测试放同目录 `_test.rs`
- 有问题找我——前端 UI、后端接口、`lib.rs` 注册都由我来配合

---

> 宫木云 2026-07-27
