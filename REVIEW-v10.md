REVIEW-v10 — V10 §1-§5
════════════════════

4 commits, 11 files, +875/-63。

✅ §1 标题栏重构 — ☰ toggle + Tab 上移 + 删浮动按钮
✅ §2 Settings overlay — fixed + blur + onClose
✅ §3 ECG 重写 — hash/RRI/asym Math.pow/firstCycle 范围渲染
✅ §4 字体渲染 — antialiased + optimizeLegibility + font-kerning + ccBg
✅ §5 Spinner — spinnerColor + spinnerSize + CSS vars

🟡 字体栈顺序反了 — index.css `--mono` 应为:
   `'Cascadia Code', 'Consolas', 'JetBrains Mono', monospace`
   当前是 JetBrains Mono 第一位 — 与设计意图不符

❌ 未做: §6 预设系统, §7 Agent CRUD + cwd 修复, §8 Radix 接入
