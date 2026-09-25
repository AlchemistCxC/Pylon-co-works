/**
 * core.commandSet.builtin —— 内置 CLI 命令集插件。
 *
 * commandRegistry 的 fallback 由此解析，保持命令清单单一来源；agent 面片段
 * 经 buildAgentCommandPrompt 注入。
 */
import {
  type CommandSetDescriptor,
} from '../../../contracts/agentCommandSet.ts'

const BUILTIN: readonly CommandSetDescriptor[] = Object.freeze([
  // #329：这 6 条是**唯一**默认进 `/` 菜单的 user 级命令。其余注册命令（browser 全家族、
  // skin、file/git、layout、theme/config…）多带原始 JSON 参数签名，属开发者/内部面，
  // 不声明 tier 即 internal，折叠在菜单的「全部」里。
  { name: 'model', tier: 'user', description: '切换模型', keywords: ['模型', '切换模型'], inputHint: ' <modelId>', agentPromptSnippet: '/model <modelId>：切换到 Agent 宣告的模型 ID。', permission: 'read', priority: 10 },
  { name: 'compact', tier: 'user', description: '压缩上下文', keywords: ['压缩', '上下文', '压缩上下文'], agentPromptSnippet: '/compact：请求压缩当前会话上下文。', permission: 'read', priority: 20 },
  { name: 'new', tier: 'user', description: '新会话', keywords: ['新会话', '新建', '新建会话'], agentPromptSnippet: '/new：开始一个新会话。', permission: 'read', priority: 30 },
  { name: 'export', tier: 'user', description: '导出记录', keywords: ['导出', '导出记录', '记录'], agentPromptSnippet: '/export：导出当前会话记录。', permission: 'read', priority: 40 },
  { name: 'clear', tier: 'user', description: '清屏', keywords: ['清屏', '清除', '清空'], agentPromptSnippet: '/clear：清空当前视图。', permission: 'read', priority: 50 },
  { name: 'mode', tier: 'user', description: '切换权限模式', keywords: ['模式', '权限模式', '权限'], inputHint: ' <modeId>', agentPromptSnippet: '/mode <modeId>：切换到 Agent 宣告的权限模式 ID（如 default / plan / acceptEdits）。', permission: 'gate', priority: 60 },
])

export const CORE_BUILTIN_COMMANDS: readonly CommandSetDescriptor[] = BUILTIN
