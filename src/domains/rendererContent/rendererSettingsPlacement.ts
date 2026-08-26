import type { RendererSettingsPlacement } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'

export interface RendererSettingsCategoryDefinition {
  readonly id: string
  readonly label: string
  readonly order: number
  readonly description: string
}

export const RENDERER_SETTINGS_CATEGORIES: readonly RendererSettingsCategoryDefinition[] = Object.freeze([
  { id: 'foundation', label: '基础与排版', order: 10, description: 'Renderer Suite、共享字体与阅读密度' },
  { id: 'markdown-text', label: 'Markdown 与文本', order: 20, description: '正文、列表、引用与搜索文本' },
  { id: 'code-terminal', label: '代码与终端', order: 30, description: '代码、ANSI、日志与差异' },
  { id: 'reasoning', label: '思考过程', order: 40, description: '思考内容、折叠与流式状态' },
  { id: 'tool-activity', label: '工具活动', order: 50, description: '工具轨道、工具卡与执行状态' },
  { id: 'workflow', label: '任务与协作', order: 60, description: '子代理、工作流、进程与后台任务' },
  { id: 'files-resources', label: '文件与资源', order: 70, description: '文件、文档、资源、媒体与产物' },
  { id: 'interaction-diagnostic', label: '交互与诊断', order: 80, description: '权限、决策、会话信息与诊断' },
  { id: 'plugin-extension', label: '插件扩展', order: 90, description: '插件提供但未进入稳定内置类别的设置' },
  { id: 'advanced-catalog', label: '高级目录', order: 100, description: 'Suite、Slot、Kind、例外与不可用设置' },
])

const categoryById = new Map(RENDERER_SETTINGS_CATEGORIES.map(category => [category.id, category]))

function placement(categoryId: string, objectOrder = 100): RendererSettingsPlacement {
  const category = categoryById.get(categoryId) ?? categoryById.get('plugin-extension')!
  return Object.freeze({
    categoryId: category.id,
    categoryLabel: category.label,
    categoryOrder: category.order,
    objectOrder,
    disclosure: category.id === 'advanced-catalog' ? 'technical' : 'essential',
  })
}

/** Built-in owners declare the semantic Settings placement for every configurable RenderKind. */
export const BUILTIN_RENDERER_SETTINGS_PLACEMENTS: Readonly<Record<string, RendererSettingsPlacement>> = Object.freeze({
  'content.text': placement('markdown-text', 10),
  'content.markdown': placement('markdown-text', 20),
  'content.search-result': placement('markdown-text', 30),
  'content.link': placement('markdown-text', 40),

  'content.code': placement('code-terminal', 10),
  'content.ansi': placement('code-terminal', 20),
  'content.terminal': placement('code-terminal', 30),
  'content.log': placement('code-terminal', 40),
  'content.diff': placement('code-terminal', 50),

  'content.reasoning': placement('reasoning', 10),
  'content.redacted-reasoning': placement('reasoning', 20),

  'tool.generic': placement('tool-activity', 10),
  'tool.input': placement('tool-activity', 20),
  'tool.progress': placement('tool-activity', 30),
  'tool.output': placement('tool-activity', 40),
  'tool.error': placement('tool-activity', 50),
  'tool.read': placement('tool-activity', 60),
  'tool.edit': placement('tool-activity', 70),
  'tool.search': placement('tool-activity', 80),
  'tool.fetch': placement('tool-activity', 90),
  'tool.execute': placement('tool-activity', 100),

  'activity.subagent': placement('workflow', 10),
  'activity.delegation': placement('workflow', 20),
  'activity.team': placement('workflow', 30),
  'activity.workflow': placement('workflow', 40),
  'activity.workflow-phase': placement('workflow', 50),
  'activity.workflow-agent': placement('workflow', 60),
  'activity.process': placement('workflow', 70),
  'activity.background-task': placement('workflow', 80),

  'content.file-reference': placement('files-resources', 10),
  'content.file-selection': placement('files-resources', 20),
  'content.document': placement('files-resources', 30),
  'content.resource': placement('files-resources', 40),
  'content.mcp-resource': placement('files-resources', 50),
  'content.memory': placement('files-resources', 60),
  'content.skill': placement('files-resources', 70),
  'content.artifact': placement('files-resources', 80),
  'content.image': placement('files-resources', 90),
  'content.audio': placement('files-resources', 100),
  'content.video': placement('files-resources', 110),

  'system.hook': placement('interaction-diagnostic', 10),
  'diagnostic.lsp': placement('interaction-diagnostic', 20),
  'session.usage': placement('interaction-diagnostic', 30),
  'session.budget': placement('interaction-diagnostic', 40),
  'session.config': placement('interaction-diagnostic', 50),
  'session.commands': placement('interaction-diagnostic', 60),
  'assist.prediction': placement('interaction-diagnostic', 70),
  'assist.file-suggestions': placement('interaction-diagnostic', 80),
  'interaction.approval': placement('interaction-diagnostic', 90),
  'interaction.questions': placement('interaction-diagnostic', 100),
  'interaction.confirm': placement('interaction-diagnostic', 110),
  'interaction.permission': placement('interaction-diagnostic', 120),
  'interaction.oauth': placement('interaction-diagnostic', 130),
  'interaction.secret': placement('interaction-diagnostic', 140),
  'interaction.sudo': placement('interaction-diagnostic', 150),
})

export function resolveRendererSettingsPlacement(
  id: string,
  contributed?: RendererSettingsPlacement,
): RendererSettingsPlacement {
  return contributed ?? BUILTIN_RENDERER_SETTINGS_PLACEMENTS[id] ?? placement('plugin-extension')
}

export function rendererSettingsCategory(categoryId: string): RendererSettingsCategoryDefinition {
  return categoryById.get(categoryId) ?? categoryById.get('plugin-extension')!
}
