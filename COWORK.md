# Pylon Co-Work License v1.0

本协议是 **宫木云** 与 **月殇** 之间的开发约定，同时作为各自 AI agent 的工作规范文档。

---

## 一、署名规范

每个源文件头部注明作者：

```
// Pylon Co-Work License
// Author: 宫木云
// File: src-tauri/src/lib.rs
```

```
// Pylon Co-Work License
// Author: 月殇
// File: src-tauri/src/gateway/qq.rs
```

---

## 二、分工边界

### 宫木云

| 范围 | 说明 |
|:--|:--|
| `src-tauri/` | 除 `src-tauri/src/gateway/` 外的全部后端 |
| `src/` | 全部前端 |
| `agents.yaml` | Agent 注册配置 |
| 架构决策 | 后端架构、协议接口、跨模块约定 |

### 月殇

| 范围 | 说明 |
|:--|:--|
| `src-tauri/src/gateway/` | Gateway 模块——外部平台桥接层 |
| 平台接入 | QQ、飞书、微信等平台 → ACP 协议转换 |
| `docs/gateway/` | 各平台接入文档 |

### 共享边界

以下文件由**双方协商**修改，动之前先在协作群喊一声：

- `src-tauri/src/lib.rs` — Gateway 模块注册、新 Tauri command
- `agents.yaml` — Gateway agent 配置项
- `src-tauri/Cargo.toml` — 新依赖
- `src-tauri/tauri.conf.json` — 新插件

---

## 三、Commit 规范

- Commit message **中文**
- **一个模块一个 commit**
- Push 前必须通过 `cargo check`
- 直接推主分支，不用 PR

---

## 四、禁止事项

- 不得修改对方分区内的文件，除非对方明确授权
- 不得手写 `windres`、修改 `build.rs`
- 新增依赖（npm / Cargo）须对方同意
- 不得提交 `node_modules/` `dist/` `target/` `.env`
- `agents.yaml` 不得包含 API key

---

## 五、Gateway 模块规范

### 目录结构

```
src-tauri/src/gateway/
├── mod.rs          # 模块入口
├── qq.rs           # QQ 平台
├── feishu.rs       # 飞书平台
├── wechat.rs       # 微信平台
└── ...
```

### 技术约束

- 协议层统一走 **ACP**（`acp.rs` 的 `AcpClient`）
- Agent 注册走 `agents.yaml`，新增平台需提供配置范例
- 纯转发——不实现 AI 逻辑，不做对话级状态管理

### 对接我这边

如需扩展以下接口，提需求，我来改：

- `lib.rs` 新增 Tauri command 或事件
- `acp.rs` 扩展 `AcpClient` 方法
- `agents.yaml` 支持新字段
- 前端新 UI 组件

---

## 六、测试

每个平台接入须包含测试用例：

- 放 `src-tauri/src/gateway/` 同目录下，文件名 `xxx_test.rs` 或 `#[cfg(test)]` 内联
- 覆盖：平台消息 → ACP 转换、ACP 响应 → 平台格式

---

## 七、文档

每个平台在 `docs/gateway/` 下提供接入说明：

```
docs/gateway/
├── qq.md           # QQ 接入：Bot token、回调地址、消息格式
├── feishu.md       # 飞书接入：应用凭证、事件订阅
└── wechat.md       # 微信接入：公众号/企业微信配置
```

文档内容包含：所需凭证、配置格式、启动步骤、消息类型映射。

---

## 八、AI Agent 协作规范

双方的 AI agent 应遵守本协议作为工作规范：

- 修改文件前读取文件头 `Author:` 确认权限
- 修改共享文件前提示用户通知对方
- 提交一个模块一个 commit，不混合修改
- 不猜测对方的接口——优先查阅 `docs/api-reference.md`

---

> 签字：宫木云、月殇
> 日期：________
