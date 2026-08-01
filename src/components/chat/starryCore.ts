// 高亮核心包装：只 re-export createStarryNight 与 toHtml 供 codeHighlight 动态导入。
// 不能直接 import('@wooorm/starry-night')——包根会连带 re-export 全部语法集
// （all/common，约 8MB 未压缩），且动态 import 无法 tree-shake 具名导出；
// rollup 对"具名 re-export"可做 tree-shake，经此包装仅把 textmate/oniguruma 引擎
// 打进懒加载 chunk，语法定义仍按语言子路径按需加载。
export { createStarryNight } from '@wooorm/starry-night'
export { toHtml } from 'hast-util-to-html'
