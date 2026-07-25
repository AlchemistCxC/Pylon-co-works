# Pylon Bug 清单

> 宫木云汇报，Riccati 记录。**V9 审计发现两个编译级严重 bug。**

---

## 🔴 C1 — send_message 重复 window 参数（编译错误）

**位置**：`lib.rs` L42-43

```rust
async fn send_message(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    window: tauri::Window,       // ← 重名，Rust 不合法
```

**修复**：删掉一行。

---

## 🔴 C2 — export_session 重复 broadcast + 误粘代码

**位置**：`lib.rs` L229-255

问题 1：L229 和 L242 各一个 `resubscribe()`，L242 的 shadow 掉 L229。L232 的 `handle` 从第一个 broadcast 读，但 L256 `load_session` 后 handle 读到的是旧 channel 的锁。

问题 2：L242-255 是从 `load_persisted_session` 误复制过来的——引用了 `source` 变量但 `export_session` 的参数里没有 `source`（这个函数只有 `peri_id`、`format`、`output_path`）。**直接编译失败。**

**修复**：删 L242-255（整段误粘），只保留 L229-241 的 broadcast + handle 收集逻辑。

---

## B1 — mcpServers 格式不兼容（已修 ✅）

---

## B2 — chat header 显示 raw session ID

---

## B3 — 左侧栏折叠按钮找不到

---

## B4 — 心电图波形循环重复（已修 ✅）

---

## B5 — 历史会话无记录

**状态**：`load_persisted_session` 逻辑正确（L179-207）。需端到端验证。

---

## B6 — 会话设置 UI 难看（已修 ✅）

---

## B7 — 删除按钮不在左栏最右侧（已修 ✅）
