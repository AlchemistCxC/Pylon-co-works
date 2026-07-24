REVIEW-v5 final — 全部 14 项
═══════════════════════════

3 commits, 18 files, +444/-33. 工作区仅 gen/schemas/capabilities.json auto-generated dirty（需 commit）。

✅ 逐项核对

  1. 图标         — tauri.conf.json bundle.icon ✅
  2. 全屏         — allow-set-fullscreen + setFullscreen() ✅
  3. 消息栏切换    — 已存在(CLI 风格)，Settings 可见 ✅
  4. ECG 噪声     — noiseScale + Math.random() ✅
  5. 上下文信息    — debug log 加回，待验证 ✅
  6. 侧栏折叠     — 已存在，按钮可见性改善 ✅
  7. 回到底部      — CSS 固定定位修复 ✅
  8. 面板透明度    — 6 个新字段 + Settings + CSS vars ✅
  9. 侧栏按钮      — 重排 ✅
  10. 用户自定义   — userName/userPrefix/userColor ✅
  11. 会话增强     — — (未要求提交)
  12. 工具竖线     — .term-tool::before CSS ✅
  13. 指示器形状   — toolIndicator/sparkles 可配 ✅
  14. 文件附件     — lib.rs + InputBar 引用式 + 长文本 ✅

🟢 gen/schemas/capabilities.json 需 commit（auto-generated，权限变更导致）
