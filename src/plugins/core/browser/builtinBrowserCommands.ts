import { invoke } from '@tauri-apps/api/core'
import type { CommandDefinition } from '../../../plugin-runtime/commands/commandRegistry.ts'
import { useWorkspaceStore } from '../../../workspaceStore.ts'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function requiredText(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 必须是非空字符串`)
  return value.trim()
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function tabId(value: unknown): number {
  const id = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(id) || id <= 0) throw new Error('tabId 必须是正整数')
  return id
}

const transport = {
  invoke: (command: string, args?: unknown) => invoke(command, args as Record<string, unknown> | undefined),
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(resolve, milliseconds))
}

/**
 * 打开/聚焦 Browser Sheet，并等待其活动视图完成首次启动。
 *
 * Browser 的原生 bounds 由 Sheet DOM 测量后提供，不能在 command registry
 * 初始化时直接创建 WebView；这里先让 workspace store 聚焦 Sheet，再给
 * React 一个短暂的挂载窗口，最后把最新状态交给 Agent。
 */
async function ensureBrowserSheet(initialUrl?: string): Promise<Record<string, unknown>> {
  const store = useWorkspaceStore.getState()
  const existing = store.workspaceSheets.sheets.find(sheet => sheet.kind === 'browser')
  const sheetId = existing?.id ?? store.openSheet({ kind: 'browser', title: 'Browser' })
  if (!sheetId) throw new Error('Browser Sheet 尚未注册，无法打开浏览器')
  store.focusSheet(sheetId)

  let status = record(await transport.invoke('browser_status'))
  for (let attempt = 0; attempt < 40 && status.phase !== 'ready' && status.phase !== 'error'; attempt += 1) {
    await wait(50)
    status = record(await transport.invoke('browser_status'))
  }

  if (initialUrl && status.phase === 'ready') {
    status = record(await transport.invoke('browser_navigate', { url: initialUrl }))
  }
  return { sheetId, ready: status.phase === 'ready', browser: status }
}

/**
 * Browser Sheet 的 Agent 控制面。
 *
 * 这些命令注册到现有 Command Registry，因此 Agent 通过唯一的 `pylon_cli`
 * 工具执行 `command exec browser.*` 即可使用，不需要额外伪造一套 MCP 字典。
 * 页面观察/交互实际落到桌面 WebView2；浏览器开发预览会返回明确的 preview 限制。
 */
export function createBuiltinBrowserCommandDefinitions(): CommandDefinition[] {
  const base = 620
  return [
    {
      id: 'browser.ensure', name: 'browser.ensure', description: '打开或聚焦 Browser Sheet，并等待浏览器会话就绪',
      permission: 'execute', priority: base - 1, inputHint: '{ "url?": "https://example.com" }',
      agentPromptSnippet: 'browser.ensure {url?}：确保 Browser Sheet 已打开并返回可用会话。',
      execute: ({ args }) => {
        const value = optionalText(record(args).url)
        const url = value && /^https?:\/\//i.test(value) ? value : value ? `https://${value}` : undefined
        return ensureBrowserSheet(url)
      },
    },
    {
      id: 'browser.status', name: 'browser.status', description: '读取 Browser Sheet 会话、活动标签和地址',
      permission: 'read', priority: base,
      agentPromptSnippet: 'browser.status：读取当前浏览器标签与活动地址。',
      execute: () => transport.invoke('browser_status'),
    },
    {
      id: 'browser.navigate', name: 'browser.navigate', description: '在当前浏览器标签导航到 http/https URL',
      permission: 'execute', priority: base + 1, inputHint: '{ "url": "https://example.com" }',
      agentPromptSnippet: 'browser.navigate {url}：在当前标签打开 URL。',
      execute: ({ args }) => transport.invoke('browser_navigate', { url: requiredText(record(args).url, 'url') }),
    },
    {
      id: 'browser.open-tab', name: 'browser.open-tab', description: '创建并激活指定 URL 的内部标签',
      permission: 'execute', priority: base + 2, inputHint: '{ "url": "https://example.com" }',
      agentPromptSnippet: 'browser.open-tab {url}：新建并激活内部浏览器标签。',
      execute: ({ args }) => transport.invoke('browser_open_tab', { url: requiredText(record(args).url, 'url') }),
    },
    {
      id: 'browser.new-tab', name: 'browser.new-tab', description: '创建并激活一个空白内部标签',
      permission: 'execute', priority: base + 3,
      execute: () => transport.invoke('browser_new_tab'),
    },
    {
      id: 'browser.select-tab', name: 'browser.select-tab', description: '切换活动浏览器标签',
      permission: 'execute', priority: base + 4, inputHint: '{ "tabId": 2 }',
      execute: ({ args }) => transport.invoke('browser_select_tab', { tabId: tabId(record(args).tabId) }),
    },
    {
      id: 'browser.close-tab', name: 'browser.close-tab', description: '关闭一个内部浏览器标签',
      permission: 'execute', priority: base + 5, inputHint: '{ "tabId": 2 }',
      execute: ({ args }) => transport.invoke('browser_close_tab', { tabId: tabId(record(args).tabId) }),
    },
    {
      id: 'browser.back', name: 'browser.back', description: '当前标签后退',
      permission: 'execute', priority: base + 6,
      execute: () => transport.invoke('browser_back'),
    },
    {
      id: 'browser.forward', name: 'browser.forward', description: '当前标签前进',
      permission: 'execute', priority: base + 7,
      execute: () => transport.invoke('browser_forward'),
    },
    {
      id: 'browser.reload', name: 'browser.reload', description: '刷新当前标签',
      permission: 'execute', priority: base + 8,
      execute: () => transport.invoke('browser_reload'),
    },
    {
      id: 'browser.snapshot', name: 'browser.snapshot', description: '读取当前页面正文摘要和可见链接',
      permission: 'read', priority: base + 9,
      agentPromptSnippet: 'browser.snapshot：读取当前页面文本和链接（不包含 cookie/storage）。',
      execute: () => transport.invoke('browser_snapshot'),
    },
    {
      id: 'browser.click', name: 'browser.click', description: '按 CSS selector 或可见文本点击页面元素',
      permission: 'execute', priority: base + 10, inputHint: '{ "selector": "button.submit" } 或 { "text": "提交" }',
      execute: ({ args }) => {
        const input = record(args)
        const selector = optionalText(input.selector)
        const text = optionalText(input.text)
        if (!selector && !text) throw new Error('selector 或 text 至少提供一个')
        return transport.invoke('browser_click', { ...(selector ? { selector } : {}), ...(text ? { text } : {}) })
      },
    },
    {
      id: 'browser.type', name: 'browser.type', description: '向当前焦点或指定 selector 的输入控件写入文本',
      permission: 'execute', priority: base + 11, inputHint: '{ "text": "hello", "selector": "input[name=q]" }',
      execute: ({ args }) => {
        const input = record(args)
        const text = requiredText(input.text, 'text')
        const selector = optionalText(input.selector)
        return transport.invoke('browser_type', { text, ...(selector ? { selector } : {}) })
      },
    },
    {
      id: 'browser.press', name: 'browser.press', description: '向当前页面派发键盘按键',
      permission: 'execute', priority: base + 12, inputHint: '{ "key": "Enter" }',
      execute: ({ args }) => transport.invoke('browser_press', { key: requiredText(record(args).key, 'key') }),
    },
    {
      id: 'browser.scroll', name: 'browser.scroll', description: '滚动当前页面',
      permission: 'execute', priority: base + 13, inputHint: '{ "deltaY": 600 }',
      execute: ({ args }) => {
        const input = record(args)
        const deltaX = typeof input.deltaX === 'number' && Number.isFinite(input.deltaX) ? Math.trunc(input.deltaX) : 0
        const deltaY = typeof input.deltaY === 'number' && Number.isFinite(input.deltaY) ? Math.trunc(input.deltaY) : 600
        return transport.invoke('browser_scroll', { deltaX, deltaY })
      },
    },
    {
      id: 'browser.zoom', name: 'browser.zoom', description: '设置当前 Browser Sheet 缩放比例',
      permission: 'execute', priority: base + 14, inputHint: '{ "zoomPercent": 90 }',
      execute: ({ args }) => {
        const value = record(args).zoomPercent
        if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('zoomPercent 必须是整数')
        return transport.invoke('browser_set_zoom', { zoomPercent: value })
      },
    },
  ]
}
