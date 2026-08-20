import { describe, expect, it } from 'vitest'
import { KERNEL_ACCEPTANCE_STORAGE_KEY, shouldExposeKernelAcceptanceControls } from '../kernelAcceptanceControls'

describe('Kernel acceptance controls gate', () => {
  it('Vite dev 模式直接开放', () => {
    expect(shouldExposeKernelAcceptanceControls(true, null)).toBe(true)
  })

  it('静态 Tauri 页面必须由 localStorage 显式开启', () => {
    expect(shouldExposeKernelAcceptanceControls(false, { getItem: () => null })).toBe(false)
    expect(shouldExposeKernelAcceptanceControls(false, {
      getItem: key => key === KERNEL_ACCEPTANCE_STORAGE_KEY ? '1' : null,
    })).toBe(true)
  })

  it('storage 访问异常时保持关闭', () => {
    expect(shouldExposeKernelAcceptanceControls(false, {
      getItem: () => { throw new Error('storage unavailable') },
    })).toBe(false)
  })
})
