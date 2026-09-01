import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_INPUT_PREDICTION_SETTINGS,
  createPredictionRouter,
  createStandalonePredictionProvider,
  normalizeInputPredictionSettings,
} from '../domains/inputPrediction/inputPredictionSettings'
import { boundPredictionMessages } from '../renderers/solid-workbench/input/inputPredictionProvider'

describe('独立输入预测设置与 provider', () => {
  it('归一化模式、数值范围和默认值', () => {
    const value = normalizeInputPredictionSettings({ mode: 'standalone', temperature: 9, topP: -1, maxTokens: 2.6 })
    expect(value.mode).toBe('standalone')
    expect(value.temperature).toBe(2)
    expect(value.topP).toBe(0)
    expect(value.maxTokens).toBe(3)
    expect(normalizeInputPredictionSettings(null)).toMatchObject(DEFAULT_INPUT_PREDICTION_SETTINGS)
  })

  it('发送 bounded transcript、推理等级和 OpenAI 兼容参数并解析响应', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.messages).toEqual([
        { role: 'system', content: DEFAULT_INPUT_PREDICTION_SETTINGS.systemPrompt },
        { role: 'user', content: '上一句' },
        { role: 'assistant', content: '上一答' },
        { role: 'user', content: '当前草稿' },
      ])
      expect(body.reasoning_effort).toBe('high')
      expect(body.top_p).toBe(1)
      return new Response(JSON.stringify({ choices: [{ message: { content: '下一句' } }] }), { status: 200 })
    })
    const settings = { ...DEFAULT_INPUT_PREDICTION_SETTINGS, enabled: true, baseUrl: 'https://example.test/v1', apiKey: 'key', model: 'model', reasoningEffort: 'high' as const }
    const provider = createStandalonePredictionProvider({ fetch, settings: () => settings })
    await expect(provider.predict({ sessionId: 's', draft: '当前草稿', history: [], messages: [{ role: 'user', content: '上一句' }, { role: 'assistant', content: '上一答' }], signal: new AbortController().signal })).resolves.toBe('下一句')
    expect(fetch).toHaveBeenCalledWith('https://example.test/v1/chat/completions', expect.objectContaining({ method: 'POST' }))
  })

  it('路由按模式只选择一条路径，不重复 fallback', async () => {
    const fork = { predict: vi.fn(async () => 'fork') }
    const standalone = { predict: vi.fn(async () => 'standalone') }
    const request = { sessionId: 's', draft: '', history: [], signal: new AbortController().signal }
    const router = createPredictionRouter({ forkProvider: fork, standaloneProvider: standalone, settings: () => ({ ...DEFAULT_INPUT_PREDICTION_SETTINGS, mode: 'standalone' }) })
    await expect(router.predict(request)).resolves.toBe('standalone')
    expect(fork.predict).not.toHaveBeenCalled()
    const off = createPredictionRouter({ forkProvider: fork, standaloneProvider: standalone, settings: () => ({ ...DEFAULT_INPUT_PREDICTION_SETTINGS, mode: 'off' }) })
    await expect(off.predict(request)).resolves.toBeNull()
  })
})

describe('输入预测上下文边界', () => {
  it('按条数和字符上限保留最新完整消息', () => {
    expect(boundPredictionMessages([
      { role: 'user', content: '旧消息' },
      { role: 'assistant', content: '中间回答' },
      { role: 'user', content: '最新消息' },
    ], { maxHistoryItems: 2, maxHistoryChars: 20 })).toEqual([
      { role: 'assistant', content: '中间回答' },
      { role: 'user', content: '最新消息' },
    ])
  })
})
