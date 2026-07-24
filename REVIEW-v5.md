REVIEW-v5 — V5 P0/P1
═══════════════════

2 commits, 8 files, +322/-11. 工作区干净。

✅ 已实现 (9/14)

  P0: 图标, 全屏(allow-set-fullscreen), 滚动按钮CSS, 折叠按钮,
       ECG噪声(noiseScale+Math.random), usage_update debug log
  P1: 工具竖线(.term-tool::before), StatusBar重排(margin-left:auto),
       删除确认(window.confirm)

  #3 输入栏模式切换 — 已存在(Settings→输入栏→CLI风格),无需改

❌ 未实现 (4/14)

  #8 面板透明度/模糊度独立可调 — store缺字段
  #9 侧栏搜索/按钮突兀 — 未动
  #10 自定义用户ID/颜色/会话名/消息数 — 未动
  #11 消息栏风格自定义 — 未动
  #13 指示器形状/颜色自定义 — 未动,Settings缺控件
  #14 文件引用式附件+长文本压缩 — 未动

🟢 可接受

  ECG噪声已加但不含行波循环(第4项第二部分) — 噪声让波形变自然,
  行波重构可以后续做。当前不算bug。
