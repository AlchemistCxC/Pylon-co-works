import '@testing-library/jest-dom/vitest'

// 组件测试（jsdom）所需的最小浏览器 API 垫片
import { afterAll, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})

// 阶段 0（报告 §2.3.9）：测试结束断言无未处理 Promise rejection。
// 每个测试文件（setup 每文件执行）注册收集器，afterAll 断言；意外 console.error
// 先收集并打印，阶段 8 错误分层后再转硬断言（现有代码存在预期的 console.error）。
const unhandledRejections: unknown[] = []
const onUnhandledRejection = (reason: unknown): void => { unhandledRejections.push(reason) }
process.on('unhandledRejection', onUnhandledRejection)

const consoleErrors: unknown[] = []
const originalConsoleError = console.error
console.error = (...args: unknown[]) => {
  consoleErrors.push(args)
  originalConsoleError(...args)
}

afterAll(() => {
  process.removeListener('unhandledRejection', onUnhandledRejection)
  if (consoleErrors.length > 0) {
    console.log(`[setup] 本测试文件出现 ${consoleErrors.length} 次 console.error（阶段 8 前仅记录）`)
  }
  if (unhandledRejections.length > 0) {
    console.error(`[setup] 检测到 ${unhandledRejections.length} 个未处理的 Promise rejection`)
    throw new Error(`存在 ${unhandledRejections.length} 个未处理的 Promise rejection`)
  }
})

// Node 26 的全局 localStorage 是实验性 getter：未传 --localstorage-file 时访问即触发
// ExperimentalWarning 并返回 undefined（且会遮蔽 jsdom 的）。无条件用内存垫片覆盖该
// descriptor（configurable: true），消除 warning 并让 zustand persist 可用（仅测试环境）。
const memory = new Map<string, string>()
const storage: Storage = {
  getItem: key => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key, value) => { memory.set(key, String(value)) },
  removeItem: key => { memory.delete(key) },
  clear: () => memory.clear(),
  key: index => [...memory.keys()][index] ?? null,
  get length() { return memory.size },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
if (typeof window !== 'undefined' && Object.getOwnPropertyDescriptor(window, 'localStorage')?.value === undefined) {
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true })
}

// matchMedia：motion/react 的 useReducedMotion 在 jsdom 下会访问
if (typeof window !== 'undefined' && typeof window.matchMedia === 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

// CodeMirror 6 会测量 Range 几何；jsdom 只实现 Range 数据模型，不提供布局 API。
// 组件测试不验证像素坐标，返回空矩形即可排除测试环境噪音。
if (typeof Range !== 'undefined' && typeof Range.prototype.getClientRects === 'undefined') {
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  }) as DOMRectList
}
if (typeof Range !== 'undefined' && typeof Range.prototype.getBoundingClientRect === 'undefined') {
  Range.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0,
    toJSON: () => ({}),
  })
}
