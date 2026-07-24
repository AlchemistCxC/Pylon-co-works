REVIEW — a2da35c refactor: async ACP init + spinner polish
══════════════════════════════════════════════

acp.rs / lib.rs — async 重构
────────────────────────────
✅ spawn/call_sync/new_session/set_mode → async，block_on → .await
✅ rt.block_on 外层包装，不再嵌套 panic
✅ call_async 先注册 oneshot 再写 stdin（无竞态）
✅ resubscribe 在 send_prompt_atomic 之前（无丢帧）
✅ send_prompt + register_response 两个 deprecated 已删
✅ .expect() 替代 ? 在 async 块内
✅ load_sessions 命令干净

ChatView.tsx — spinner 成语轮转
────────────────────────────────
✅ SPARKLES 简化写法
✅ +14 成语
✅ 成语按 tick 轮转逻辑正确

ChatView.css — spinner 间距
────────────────────────────
✅ 纯视觉微调，无问题

index.css — ⚠️ 新增 --accent 被覆盖
────────────────────────────────────
:root 里有两个 --accent：

  L8:  --accent: #3b82f6;           ← 你新增的蓝色
  ...
  L18: --accent: rgba(0,0,0,0.65);  ← 旧的深灰色

L18 在 L8 后面，会覆盖 L8。#3b82f6 永远不生效。

→ 如果目的是改蓝色 accent：删 L18
→ 如果没打算改：删 L8
