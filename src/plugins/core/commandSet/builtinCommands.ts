/**
 * core.commandSet.builtin —— 内置 CLI 命令集插件。
 *
 * 与旧 FALLBACK_COMMANDS 保持同一命令清单；M2 起 commandRegistry 的 fallback
 * 也由此解析（双面同源）。agent 面片段经 buildAgentCommandPrompt 注入。
 */
import {
  type CommandSetDescriptor,
} from '../../../contracts/agentCommandSet.ts'

const BUILTIN: readonly CommandSetDescriptor[] = Object.freeze([
  { name: 'model', description: '切换模型', inputHint: ' <name>', agentPromptSnippet: '/model <name>：切换当前会话使用的模型。', permission: 'read', priority: 10 },
  { name: 'compact', description: '压缩上下文', agentPromptSnippet: '/compact：请求压缩当前会话上下文。', permission: 'read', priority: 20 },
  { name: 'new', description: '新会话', agentPromptSnippet: '/new：开始一个新会话。', permission: 'read', priority: 30 },
  { name: 'export', description: '导出记录', agentPromptSnippet: '/export：导出当前会话记录。', permission: 'read', priority: 40 },
  { name: 'clear', description: '清屏', agentPromptSnippet: '/clear：清空当前视图。', permission: 'read', priority: 50 },
  { name: 'mode', description: '切换权限模式', inputHint: ' <default|edit|auto|bypass>', agentPromptSnippet: '/mode <default|edit|auto|bypass>：切换权限模式。', permission: 'gate', priority: 60 },
])

export const CORE_BUILTIN_COMMANDS: readonly CommandSetDescriptor[] = BUILTIN
