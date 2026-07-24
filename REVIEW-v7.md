# REVIEW-v7 — 审计报告

**基线**: `2a8fc29`  
**HEAD**: `9913942` ("feat: V7 session settings popup (⚙ per session), pylon localStorage")  
**审计时间**: 2026-07-25 (cron 自动审计)  
**作者**: GMY <3294447364@qq.com>  
**提交数**: 3 commits since baseline

---

## 提交历史

| Commit | 消息 |
|:-------|:-----|
| `4b0b00d` | chore: update Cargo.lock after rename |
| `1364233` | feat: V7 P0 — ECG baseline 5, dual endpoints, sidebar true hide |
| `9913942` | feat: V7 session settings popup (⚙ per session), pylon localStorage |

---

## 变更摘要

| 文件 | +/- | 类别 |
|:-----|:----|:-----|
| `DESIGN-v7.md` | +278 | 设计文档（新） |
| `REVIEW-v7.md` | +49 | 审计文档 |
| `src-tauri/Cargo.lock` | +16 / -16 | 依赖锁 |
| `src/components/SessionSettings.tsx` | +103 | 新组件 |
| `src/components/Sidebar.tsx` | +6 / -1 | UI + localStorage 迁移 |
| `src/components/Sidebar.css` | +6 / -2 | 折叠隐藏 + 齿轮按钮样式 |
| `src/components/chat/StatusBar.tsx` | +6 / -4 | ECG 视觉微调 |
| `src/components/chat/ChatView.tsx` | +1 / -1 | localStorage 键名 |
| `src/store.ts` | +5 / -5 | localStorage 键名 |
| `src/App.tsx` | +5 / -1 | SessionSettings 集成 |

**合计**: 10 files, 471 insertions, 32 deletions

---

## 变更详情

### 1. SessionSettings 弹窗组件 (`SessionSettings.tsx`, +103 行)

全新的会话设置 Modal，通过侧边栏 ⚙ 按钮触发。功能：

- **名称编辑** — 文本输入
- **平台切换** — 下拉框：本地 / QQ 群聊 / QQ 私聊 / 终端
- **工作目录** — 文本输入，留空使用 Agent 默认
- **会话级 Prompt 覆盖** — textarea，留空使用 Profile persona
- **Skills 管理** — chip 式添加/删除
- **Hooks 管理** — chip 式添加/删除
- **保存 / 取消 / 删除会话** — 三个操作按钮

#### ⚠️ 问题

| 严重度 | 问题 | 位置 |
|:-------|:-----|:-----|
| **中** | 非空断言 `sessions.find(s => s.id === sessionId)!` — 若 sessionId 无效（如会话在弹窗打开期间被其他标签页删除），组件会崩溃。建议加保护：未找到时显示 "会话不存在" 并关闭。 | `SessionSettings.tsx:8` |
| **低** | 保存逻辑直接用 `localStorage.setItem` 写入全量 sessions，在高频操作时（快速切换字段并保存）有微小竞态可能。当前每次保存都覆盖，只要单标签页操作就没问题。 | `SessionSettings.tsx:19-20` |
| **低** | `lastActiveAt: Date.now()` 在保存时更新——这不是"最后活跃时间"的语义，而是"最后编辑时间"。但影响很小，可接受。 | `SessionSettings.tsx:19` |
| **建议** | 删除会话后，调用方应自动切换到另一个会话或清空 activeSession。当前仅 close modal，activeSession 仍指向已删除的 id。 | `Sidebar.tsx` 调用处 |

---

### 2. localStorage 键名迁移: `prism-sessions` → `pylon-sessions`

**影响文件**: `store.ts` (5 处), `Sidebar.tsx` (1 处), `ChatView.tsx` (1 处)

| 严重度 | 问题 |
|:-------|:-----|
| **高** | **无迁移逻辑**。现有用户的 `prism-sessions` 数据将静默丢失——浏览器打开后所有会话消失，如同首次使用。必须添加回退读取：先读 `pylon-sessions`，若无数据则尝试 `prism-sessions` 并迁移。 |
| **低** | 聊天自动命名 (`ChatView.tsx:94`) 保存时用了 `sessions.map(...)` + 全量写入，其余地方也类似。这些在单标签页下安全。 |

> 建议在 `store.ts` 的初始化处增加迁移逻辑：
> ```ts
> const raw = localStorage.getItem('pylon-sessions') ?? localStorage.getItem('prism-sessions')
> if (raw) {
>   const parsed = JSON.parse(raw)
>   localStorage.setItem('pylon-sessions', JSON.stringify(parsed))
>   localStorage.removeItem('prism-sessions')
>   return parsed
> }
> ```

---

### 3. 侧边栏: 折叠真隐藏 + ⚙ 按钮

**Sidebar.css**:
- `.sidebar.collapsed` 新增 `overflow:hidden; background-image:none !important;` — 折叠时彻底隐藏内容和背景图，优于之前的视觉效果。

**Sidebar.tsx**:
- 新增 `onSessionSettings` prop，传递到 App 层。
- 每个会话条目右侧增加 ⚙ 按钮（`.session-gear`），hover 时与 ✕ 按钮一同显示。
- `localStorage.setItem('pylon-sessions', ...)` — 属于上述迁移的一部分。

| 严重度 | 问题 |
|:-------|:-----|
| **低** | `!important` 是样式覆盖的后门。若后续有动态背景需求可能被意外覆盖。当前可接受——折叠态不应有背景。 |

---

### 4. ECG 视觉微调 (`StatusBar.tsx`)

- **基线宽度**: `strokeWidth="3"` → `strokeWidth="5"` — 更粗的基线，视觉权重提升。
- **双端点**: 左右两侧各从 1 条竖线变为 2 条（间距 3px），`strokeWidth="2.5"` → `strokeWidth="2"`，`mid±8` → `mid±10`。

| 严重度 | 问题 |
|:-------|:-----|
| **无** | 纯视觉调整，无功能影响。两个端点的 `stroke` 用硬编码 `rgba(0,0,0,0.35)` — 在暗色主题下不可见。如果未来支持暗色模式需要改为 CSS 变量。未来问题，当前不阻塞。 |

---

### 5. Cargo.lock 重命名: `prism-desktop` → `pylon`

`4b0b00d` 的机械化变更，无功能影响。依赖集完全一致：`log, serde, serde_json, serde_yaml, tauri, tauri-build, tauri-plugin-dialog, tauri-plugin-fs, tauri-plugin-shell, tokio`。

---

### 6. 设计文档 (`DESIGN-v7.md`, +278 行)

新增 V7 设计文档。未审计内容——非代码文件，不阻塞。

---

## 风险评估

| 维度 | 评级 | 说明 |
|:-----|:-----|:-----|
| 功能影响 | **中** | 新增会话设置弹窗、侧边栏折叠真隐藏、ECG 视觉调整 |
| 破坏性 | **高** | `prism-sessions` → `pylon-sessions` 无迁移，现有用户数据丢失 |
| 安全 | **通过** | 无新增依赖、无外部请求、无 eval |
| 代码质量 | **中** | SessionSettings 非空断言、迁移缺失 |
| 审计结论 | ⚠️ **有条件通过** | 阻塞项：**必须添加 localStorage 迁移逻辑**。其余问题为建议级。 |

---

## 待办清单

| 优先级 | 项目 | 文件 |
|:-------|:-----|:-----|
| **P0** | 添加 `prism-sessions` → `pylon-sessions` 迁移逻辑 | `store.ts` |
| P1 | SessionSettings 对无效 sessionId 做防御处理 | `SessionSettings.tsx` |
| P2 | 删除会话后自动切换到其他会话或清空 activeSession | `Sidebar.tsx` / `App.tsx` |
| P3 | ECG 端点颜色改为 CSS 变量以支持暗色模式 | `StatusBar.tsx` |

---

## 变更统计

```
DESIGN-v7.md                       | 278 +++++++++++
 REVIEW-v7.md                       |  49 ++
 src-tauri/Cargo.lock               |  16 + / 16 -
 src/App.tsx                        |   5 + / 1 -
 src/components/SessionSettings.tsx | 103 ++++++
 src/components/Sidebar.css         |   6 + / 2 -
 src/components/Sidebar.tsx         |   6 + / 1 -
 src/components/chat/ChatView.tsx   |   1 + / 1 -
 src/components/chat/StatusBar.tsx  |   6 + / 4 -
 src/store.ts                       |   5 + / 5 -
 ─────────────────────────────────────────────
 10 files, 471 insertions, 32 deletions
```
