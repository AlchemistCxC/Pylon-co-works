import '@testing-library/jest-dom/vitest'

// 组件测试（jsdom）所需的最小浏览器 API 垫片
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
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
