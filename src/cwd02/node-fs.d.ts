/**
 * CWD-02 测试专用：`node:fs` 最小类型桩（与 css04/node-fs.d.ts 同内容；环境模块声明，
 * 与既有声明合并，无冲突）。项目未安装 @types/node，而 `tsc -b` include:["src"] 覆盖
 * src/**，使 cwd02 测试侧可读取真实 wire 源码做源码锁（vitest 默认 css:false 不影响
 * node:fs 读取）。仅测试侧使用，生产包不含；日后引入 @types/node 时删除本桩。
 */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string
}
