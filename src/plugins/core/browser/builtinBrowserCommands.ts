import { invoke } from '@tauri-apps/api/core'
import type { CommandDefinition } from '../../../plugin-runtime/commands/commandRegistry.ts'
import { useWorkspaceStore } from '../../../workspaceStore.ts'
import { loadBrowserLibrary } from '../../../domains/browser/browserLibrary.ts'
import {
  BrowserAgentToolError,
  createBrowserAgentClient,
} from '../../../infrastructure/tauri/browserAgentClient.ts'

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

function optionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function tabId(value: unknown): number {
  const id = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(id) || id <= 0) throw new Error('tabId 必须是正整数')
  return id
}

const transport = {
  invoke: (command: string, args?: unknown) => invoke(command, args as Record<string, unknown> | undefined),
}

const agentClient = createBrowserAgentClient((command, args) => transport.invoke(command, args))

/**
 * browser.agent-* 命令族的参数透传约定：桥进程（MCP）与 pylon_cli 工具字典
 * 都把 `sessionKey`（--session 注入）放进 args；Rust 侧以其为 claim/审计键。
 */
function agentArgs(args: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  const copy = (key: string, ...aliases: string[]) => {
    for (const alias of [key, ...aliases]) {
      if (args[alias] !== undefined && args[alias] !== null && args[alias] !== '') {
        output[key] = args[alias]
        return
      }
    }
  }
  copy('sessionKey', 'session_key')
  copy('workspaceId', 'workspace_id')
  copy('tabId', 'tab_id')
  return output
}

/** Agent 命令统一错误呈现：保留 Rust 策略信封的 code。 */
function wrapAgentError(command: string, error: unknown): never {
  if (error instanceof BrowserAgentToolError) {
    throw new Error(`[${error.code}] ${error.message}`)
  }
  throw error instanceof Error ? error : new Error(`${command} 失败：${String(error)}`)
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

    // ── browser.agent-*（issue #82）：桥进程（MCP）与 pylon_cli 共用的工具面。 ──
    // 策略/claim/审计在 Rust `browser_agent_*` 命令层单点强制；这里的失败一律
    // 以 `[code] message` 抛出，MCP 工具结果与聊天渲染都能看到结构化错误码。
    {
      id: 'browser.agent-ensure', name: 'browser.agent-ensure', description: '确保 Browser Sheet 已打开并就绪（首次使用浏览器前调用）',
      permission: 'read', priority: base + 40,
      agentPromptSnippet: 'browser.agent-ensure：确保浏览器可用，返回当前会话状态。',
      execute: () => ensureBrowserSheet(),
    },
    {
      id: 'browser.agent-navigate', name: 'browser.agent-navigate', description: '在指定浏览器标签导航到 http/https URL',
      permission: 'execute', priority: base + 41, inputHint: '{ "url": "https://example.com", "tabId?": 1 }',
      agentPromptSnippet: 'browser.agent-navigate {url}：打开 URL（受白名单与黑名单约束）。',
      execute: ({ args }) => {
        const input = record(args)
        const url = requiredText(input.url, 'url')
        return agentClient.navigate({ ...agentArgs(input), url }).catch(error => wrapAgentError('browser.agent-navigate', error))
      },
    },
    {
      id: 'browser.agent-snapshot', name: 'browser.agent-snapshot', description: '读取当前页面：可交互元素（ref/role/name/坐标）+ 正文文本',
      permission: 'read', priority: base + 42,
      agentPromptSnippet: 'browser.agent-snapshot：先 snapshot 拿 ref，再用 ref 点击/输入。',
      execute: ({ args }) => agentClient.snapshot(agentArgs(record(args))).catch(error => wrapAgentError('browser.agent-snapshot', error)),
    },
    {
      id: 'browser.agent-screenshot', name: 'browser.agent-screenshot', description: '当前页面 PNG 截图（base64；仅 Windows）',
      permission: 'read', priority: base + 43,
      agentPromptSnippet: 'browser.agent-screenshot：视觉型任务时截取当前页面。',
      execute: ({ args }) => agentClient.screenshot(agentArgs(record(args))).catch(error => wrapAgentError('browser.agent-screenshot', error)),
    },
    {
      id: 'browser.agent-wait', name: 'browser.agent-wait', description: '等待页面条件：until = load | network_idle | selector',
      permission: 'read', priority: base + 44, inputHint: '{ "until": "load" | "network_idle" | "selector", "selector?": "...", "timeoutMs?": 8000 }',
      agentPromptSnippet: 'browser.agent-wait {until}：导航后等待加载/网络静默/元素出现。',
      execute: ({ args }) => {
        const input = record(args)
        const until = requiredText(input.until, 'until')
        return agentClient.wait({
          ...agentArgs(input),
          until,
          ...(optionalText(input.selector) ? { selector: optionalText(input.selector) } : {}),
          ...(optionalNumber(input.timeoutMs) !== undefined ? { timeoutMs: optionalNumber(input.timeoutMs) } : {}),
        }).catch(error => wrapAgentError('browser.agent-wait', error))
      },
    },
    {
      id: 'browser.agent-read-network', name: 'browser.agent-read-network', description: '读取最近网络请求；带 requestId 时返回响应体文本预览（仅 Windows）',
      permission: 'read', priority: base + 45,
      agentPromptSnippet: 'browser.agent-read-network：观察 API/XHR 响应（≤64KiB 文本预览）。',
      execute: ({ args }) => {
        const input = record(args)
        return agentClient.readNetwork({
          ...agentArgs(input),
          ...(optionalNumber(input.limit) !== undefined ? { limit: optionalNumber(input.limit) } : {}),
          ...(optionalText(input.requestId) ? { requestId: optionalText(input.requestId) } : {}),
        }).catch(error => wrapAgentError('browser.agent-read-network', error))
      },
    },
    {
      id: 'browser.agent-save-page', name: 'browser.agent-save-page', description: '把当前页面存为 MHTML 归档，返回文件路径（仅 Windows）',
      permission: 'read', priority: base + 46,
      agentPromptSnippet: 'browser.agent-save-page：整页存档供后续阅读。',
      execute: ({ args }) => agentClient.savePage(agentArgs(record(args))).catch(error => wrapAgentError('browser.agent-save-page', error)),
    },
    {
      id: 'browser.agent-scroll', name: 'browser.agent-scroll', description: '滚动当前页面',
      permission: 'read', priority: base + 47, inputHint: '{ "deltaY": 600, "deltaX?": 0 }',
      execute: ({ args }) => {
        const input = record(args)
        return agentClient.scroll({
          ...agentArgs(input),
          deltaX: optionalNumber(input.deltaX) ?? 0,
          deltaY: optionalNumber(input.deltaY) ?? 600,
        }).catch(error => wrapAgentError('browser.agent-scroll', error))
      },
    },
    {
      id: 'browser.agent-tab-list', name: 'browser.agent-tab-list', description: '列出浏览器标签（id/url/title/活动态）',
      permission: 'read', priority: base + 48,
      execute: () => agentClient.tabList().catch(error => wrapAgentError('browser.agent-tab-list', error)),
    },
    {
      id: 'browser.agent-tab-new', name: 'browser.agent-tab-new', description: '新建浏览器标签；background=true 后台打开不切换视图',
      permission: 'read', priority: base + 49, inputHint: '{ "url?": "https://…", "background?": false }',
      execute: ({ args }) => {
        const input = record(args)
        return agentClient.tabNew({
          ...agentArgs(input),
          ...(optionalText(input.url) ? { url: optionalText(input.url) } : {}),
          ...(typeof input.background === 'boolean' ? { background: input.background } : {}),
        }).catch(error => wrapAgentError('browser.agent-tab-new', error))
      },
    },
    {
      id: 'browser.agent-tab-select', name: 'browser.agent-tab-select', description: '切换活动浏览器标签',
      permission: 'read', priority: base + 50, inputHint: '{ "tabId": 2 }',
      execute: ({ args }) => agentClient.tabSelect({ ...agentArgs(record(args)), tabId: tabId(record(args).tabId) }).catch(error => wrapAgentError('browser.agent-tab-select', error)),
    },
    {
      id: 'browser.agent-tab-close', name: 'browser.agent-tab-close', description: '关闭浏览器标签（full 档）',
      permission: 'execute', priority: base + 51, inputHint: '{ "tabId": 2 }',
      execute: ({ args }) => agentClient.tabClose({ ...agentArgs(record(args)), tabId: tabId(record(args).tabId) }).catch(error => wrapAgentError('browser.agent-tab-close', error)),
    },
    {
      id: 'browser.agent-click', name: 'browser.agent-click', description: '点击页面元素（full 档）；优先 snapshot 返回的 ref，也接受 CSS selector',
      permission: 'execute', priority: base + 52, inputHint: '{ "ref": "e12" } 或 { "selector": "button.submit" }',
      agentPromptSnippet: 'browser.agent-click {ref}：点击前自动高亮与指纹复核（stale_ref 需重新 snapshot）。',
      execute: ({ args }) => {
        const input = record(args)
        const reference = optionalText(input.ref) ?? optionalText(input.reference)
        const selector = optionalText(input.selector)
        if (!reference && !selector) throw new Error('ref 或 selector 至少提供一个')
        return agentClient.click({
          ...agentArgs(input),
          ...(reference ? { reference } : {}),
          ...(selector ? { selector } : {}),
        }).catch(error => wrapAgentError('browser.agent-click', error))
      },
    },
    {
      id: 'browser.agent-type', name: 'browser.agent-type', description: '向输入元素写入文本（full 档）；submit=true 追加回车',
      permission: 'execute', priority: base + 53, inputHint: '{ "text": "hello", "ref?": "e3", "selector?": "input[name=q]", "submit?": true }',
      execute: ({ args }) => {
        const input = record(args)
        const text = requiredText(input.text, 'text')
        const reference = optionalText(input.ref) ?? optionalText(input.reference)
        const selector = optionalText(input.selector)
        if (!reference && !selector) throw new Error('ref 或 selector 至少提供一个')
        return agentClient.type({
          ...agentArgs(input),
          text,
          ...(reference ? { reference } : {}),
          ...(selector ? { selector } : {}),
          ...(typeof input.submit === 'boolean' ? { submit: input.submit } : {}),
        }).catch(error => wrapAgentError('browser.agent-type', error))
      },
    },
    {
      id: 'browser.agent-press', name: 'browser.agent-press', description: '向当前焦点派发按键（full 档）：Enter/Tab/Arrow* 或单个字符',
      permission: 'execute', priority: base + 54, inputHint: '{ "key": "Enter" }',
      execute: ({ args }) => agentClient.press({ ...agentArgs(record(args)), key: requiredText(record(args).key, 'key') }).catch(error => wrapAgentError('browser.agent-press', error)),
    },
    {
      id: 'browser.agent-download', name: 'browser.agent-download', description: '从当前页面触发显式下载（full 档）',
      permission: 'execute', priority: base + 55, inputHint: '{ "url": "https://…", "filename?": "x.zip" }',
      execute: ({ args }) => {
        const input = record(args)
        return agentClient.download({
          ...agentArgs(input),
          url: requiredText(input.url, 'url'),
          ...(optionalText(input.filename) ? { filename: optionalText(input.filename) } : {}),
        }).catch(error => wrapAgentError('browser.agent-download', error))
      },
    },
    {
      id: 'browser.agent-emulate', name: 'browser.agent-emulate', description: '设备仿真：viewport（width+height）与 userAgent；clear=true 恢复（仅 Windows）',
      permission: 'read', priority: base + 56,
      execute: ({ args }) => {
        const input = record(args)
        return agentClient.emulate({
          ...agentArgs(input),
          ...(optionalNumber(input.width) !== undefined ? { width: optionalNumber(input.width) } : {}),
          ...(optionalNumber(input.height) !== undefined ? { height: optionalNumber(input.height) } : {}),
          ...(optionalText(input.userAgent) ? { userAgent: optionalText(input.userAgent) } : {}),
          ...(typeof input.clear === 'boolean' ? { clear: input.clear } : {}),
        }).catch(error => wrapAgentError('browser.agent-emulate', error))
      },
    },
    {
      id: 'browser.agent-history', name: 'browser.agent-history', description: '读取 Browser Sheet 最近浏览历史（本地库，只读）',
      permission: 'read', priority: base + 57, inputHint: '{ "limit?": 20 }',
      execute: ({ args }) => {
        const limit = optionalNumber(record(args).limit) ?? 20
        const library = loadBrowserLibrary()
        return {
          ok: true,
          history: library.history.slice(0, Math.max(1, Math.min(100, Math.trunc(limit)))).map(entry => ({
            url: entry.url,
            title: entry.title ?? null,
            visitedAt: entry.visitedAt,
          })),
        }
      },
    },
  ]
}
