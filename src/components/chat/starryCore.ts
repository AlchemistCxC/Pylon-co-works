// starry-night 包装模块——#220 WP4 切流后的**测试基线专用**入口。
//
// 生产高亮引擎已迁到 wasm 计算核（`infrastructure/compute/markdownCompute.ts` 的
// `highlightBlock`，syntect + 同源 vendored 语法）；本文件只剩 `markdownComputeParity`
// 差分门禁的 TS 基线驱动（starry-night 逐 token 对 wasm 快照），不再进生产 chunk。
// 差分门禁退役时本模块随 `@wooorm/starry-night` 依赖一起删除。
//
// 不能直接 import('@wooorm/starry-night')——包根会连带 re-export 全部语法集
// （all/common，约 8MB 未压缩），且动态 import 无法 tree-shake 具名导出；
// rollup 对"具名 re-export"可做 tree-shake，经此包装仅把 textmate/oniguruma 引擎
// 打进懒加载 chunk，语法定义仍按语言子路径按需加载。
export { createStarryNight } from '@wooorm/starry-night'
export { toHtml } from 'hast-util-to-html'
