REVIEW-v8
════════

1 commit, 4 files, +165/-10。工作区干净。

✅ 全部实现

  ECG 行波      totalW=W×2, x=-W→+W+offset, 永续右移
  offset 安全   %(W×4), 无溢出
  分段噪声      绿: sin呼吸, 黄: 0.3+强度×0.8, 红: 0.6+强度×1.5
  overflow-x    .chat-view overflow-x:hidden
  autoName      首条消息后自动命名，header 显示友好名

  ✅ 通过