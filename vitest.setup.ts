import '@testing-library/jest-dom/vitest'

// 组件测试（jsdom）所需的最小浏览器 API 垫片
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})

// Node 26 的实验性全局 localStorage 不可用（需 --localstorage-file）且会遮蔽 jsdom 的；
// zustand persist 依赖 localStorage —— 提供内存垫片（仅测试环境）
if (typeof globalThis.localStorage === 'undefined') {
  const memory = new Map<string, string>()
  const storage: Storage = {
    getItem: key => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key, value) => { memory.set(key, String(value)) },
    removeItem: key => { memory.delete(key) },
    clear: () => memory.clear(),
    key: index => [...memory.keys()][index] ?? null,
    get length() { return memory.size },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  if (typeof window !== 'undefined' && typeof window.localStorage === 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true })
  }
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
