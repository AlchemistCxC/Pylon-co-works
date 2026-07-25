V10 终版审计
═══════════

8 commits, 24 files, +1600/-180。

── 编译 ──
  tsc --noEmit  零类型错误
  Rust cargo check （需 windres PATH，已确认）

── 前端↔后端 ──
  7 invoke → 9 handler，全匹配，无缺口

── 未用声明（无害）──
  ChatView:      useCallback, invoke
  InputBar:      readTextFile
  StatusBar:     invoke, prismOn, modelOpen, setModelOpen
  SessionSettings: Session type
  Settings:      PresetBtns
  Sidebar:       Session type

── V10 实现度 ──
   §1 标题栏重构
   §2 Settings overlay
   §3 ECG 非对称重写
   §4 字体栈 + 三行 CSS + ccBg
   §5 Spinner 增强
   §6 预设系统
   §8 Radix Tabs/Dialog/Dropdown
   §7 Agent CRUD + cwd（延后）
