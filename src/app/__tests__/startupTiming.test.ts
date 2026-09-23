// #269：startupTiming 模块契约——相位追加顺序、上报幂等、payload 形状、静默失败。
// 模块持有进程级状态（相位数组 + reported 旗标）：每个用例经 resetModules 取全新
// 实例；@tauri-apps/api/core 整体 mock（工厂随 registry 重建产生全新 vi.fn），
// 同一用例内经动态 import 取到的即被测模块实际引用的 mock 实例。
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
  isTauri: vi.fn(() => true),
}))

async function importFresh() {
  vi.resetModules()
  const timing = await import('../startupTiming')
  const core = await import('@tauri-apps/api/core')
  return {
    timing,
    invoke: vi.mocked(core.invoke),
    isTauri: vi.mocked(core.isTauri),
  }
}

describe('startupTiming', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('startupMark 按调用顺序追加相位，elapsed 单调不减且 epoch 接近当前时刻', async () => {
    const { timing } = await importFresh()
    const before = Date.now()
    timing.startupMark('a')
    timing.startupMark('b')
    const marks = timing.startupPhaseMarks()
    expect(marks.map(mark => mark.phase)).toEqual(['a', 'b'])
    expect(marks[0]!.elapsedMs).toBeLessThanOrEqual(marks[1]!.elapsedMs)
    for (const mark of marks) {
      expect(mark.epochMs).toBeGreaterThanOrEqual(before)
      expect(mark.epochMs).toBeLessThanOrEqual(Date.now())
      expect(Number.isInteger(mark.elapsedMs)).toBe(true)
    }
  })

  it('返回的只读视图与内部数组同源（形状契约：phase/elapsedMs/epochMs）', async () => {
    const { timing } = await importFresh()
    timing.startupMark('main_module_eval')
    const [mark] = timing.startupPhaseMarks()
    expect(Object.keys(mark!).sort()).toEqual(['elapsedMs', 'epochMs', 'phase'])
  })

  it('Tauri 环境下 reportStartupTiming 恰好上报一次完整相位数组', async () => {
    const { timing, invoke, isTauri } = await importFresh()
    isTauri.mockReturnValue(true)
    timing.startupMark('first')
    timing.startupMark('ready')
    timing.reportStartupTiming()
    timing.reportStartupTiming()
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('report_startup_timing', {
      phases: expect.arrayContaining([
        expect.objectContaining({ phase: 'first' }),
        expect.objectContaining({ phase: 'ready' }),
      ]),
    })
    // 上报的是快照副本：上报后新增相位不影响已上报内容，也不重发。
    timing.startupMark('after_report')
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('非 Tauri 环境（浏览器模式）不发起 invoke', async () => {
    const { timing, invoke, isTauri } = await importFresh()
    isTauri.mockReturnValue(false)
    timing.startupMark('ready')
    timing.reportStartupTiming()
    await Promise.resolve()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('invoke 拒绝时静默吞掉，不向调用方抛错', async () => {
    const { timing, invoke, isTauri } = await importFresh()
    isTauri.mockReturnValue(true)
    invoke.mockRejectedValueOnce(new Error('no backend'))
    timing.startupMark('ready')
    expect(() => timing.reportStartupTiming()).not.toThrow()
    await expect(Promise.resolve()).resolves.toBeUndefined()
  })
})
