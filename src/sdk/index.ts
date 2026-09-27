/**
 * Pylon 插件开发 SDK（public authoring surface）——契约面（`./contract.ts`，
 * 纯类型，覆盖 API 1.0–1.3 / 2.0–2.4 全部 context 面与贡献类型）+ 运行时面
 * （`./runtime.ts`，常量表与纯函数 helpers）。
 *
 * 插件作者统一从本入口 import；事实源为 `src/sdk/`，打包约束见 runtime.ts 头注。
 */
export * from './contract.ts'
export * from './runtime.ts'
