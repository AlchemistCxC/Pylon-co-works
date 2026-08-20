/**
 * CSS-04 测试专用：`node:fs` 最小类型桩。
 *
 * 项目未安装 @types/node，而 `tsc -b`（tsconfig.json include:["src"]）覆盖 src/**，
 * 使 css04 测试侧读取真实 CSS 文本（vitest 默认 `css:false` 将 .css 导入置空）成为可能。
 * 本文件为无导入的 script 上下文 `.d.ts`，`declare module` 走"环境模块声明"而非增强，
 * 故可被 `import { readFileSync } from 'node:fs'` 解析。仅测试侧使用，生产包不含；
 * 若日后引入 @types/node，删除本桩即可。
 */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string
}
