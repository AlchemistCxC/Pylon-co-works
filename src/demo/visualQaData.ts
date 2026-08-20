/**
 * visualQaData — 浏览器 Dev 模式的高密度视觉验收场景。
 *
 * 只提供纯 builder；真实桌面端永远不会加载这些会话。场景刻意覆盖长标题、空态、
 * 多语言、长上下文、工具状态矩阵、错误恢复、插件开发和窄窗口文案。
 */
import type { Session } from '../identityStore.ts'
import type { Message } from '../components/chat/messageTypes.ts'
import type { Workspace } from '../workspaceEntities.ts'
import type { InstalledPluginPackage } from '../infrastructure/plugins/pluginPackageClient.ts'
import { createMockMessages } from '../components/chat/chatMockData.ts'

const HOUR = 3_600_000
const QA_NOW = Date.now()

function qaSession(
  id: string,
  agentId: string,
  name: string,
  workdir: string,
  workspaceId: string | undefined,
  ageHours: number,
): Session {
  return {
    id,
    agentId,
    periId: `remote-${id}`,
    name,
    source: `local:${id}`,
    profileId: agentId === 'gm' ? 'local' : 'default',
    createdAt: QA_NOW - (ageHours + 24) * HOUR,
    lastActiveAt: QA_NOW - ageHours * HOUR,
    platform: agentId === 'hermes' ? 'webhook' : agentId === 'gm' ? 'web' : 'local',
    workdir,
    workspaceId,
    sessionPrompt: '',
    skills: [],
    hooks: [],
    autoName: name,
  }
}

export function buildVisualQaSessions(): Session[] {
  return [
    qaSession('demo-visual-matrix', 'peri', '渲染状态全景 · Tool / Thought / Markdown', '/path/to/pylon', 'w-pylon', 0.02),
    qaSession('demo-design-audit', 'peri', '设置页视觉审计与材质层级', '/path/to/pylon', 'w-pylon', 0.3),
    qaSession('demo-mobile-layout', 'peri', '窄窗口与超长标题溢出验收——这是一个故意很长的会话名称', '/path/to/pylon-design', 'w-design', 2),
    qaSession('demo-long-context', 'claude', '长上下文架构评审（36 条消息）', '/path/to/agent-runtime', 'w-agent-lab', 1),
    qaSession('demo-task-swarm', 'pi', '并行任务与工具状态压力场景', '/path/to/agent-runtime', 'w-agent-lab', 3),
    qaSession('demo-plugin-authoring', 'claude', 'GUI 化渲染插件 · API 1.0', '/path/to/gui-renderer', 'w-plugin-lab', 4),
    qaSession('demo-i18n', 'gm', '多语言排版 · 中文 English 日本語 العربية', '/path/to/worldbook', 'w-worldbook', 6),
    qaSession('demo-error-recovery', 'hermes', '部署失败 → 回滚 → 恢复', '/path/to/ops', 'w-operations', 8),
    qaSession('demo-empty', 'pi', '空白新会话', '/path/to/sandbox', 'w-sandbox', 10),
    qaSession('demo-unbound', 'hermes', '未绑定工作区的旧会话', '/path/to/legacy/unbound', undefined, 24),
  ]
}

export function buildVisualQaWorkspaces(): Workspace[] {
  return [
    { id: 'w-pylon', agentId: 'peri', name: 'Pylon Desktop', rootPath: '/path/to/pylon', createdAt: QA_NOW - 40 * HOUR, lastActiveAt: QA_NOW, skills: ['frontend', 'visual-qa'], mcpServerIds: ['filesystem', 'browser'], hookPluginIds: ['builtin.skin'] },
    { id: 'w-agent-lab', agentId: 'claude', name: 'Agent Runtime Lab', rootPath: '/path/to/agent-runtime', createdAt: QA_NOW - 96 * HOUR, lastActiveAt: QA_NOW - HOUR, skills: ['acp', 'runtime-probe'], mcpServerIds: ['filesystem'], hookPluginIds: [] },
    { id: 'w-design', agentId: 'peri', name: '视觉革命设计系统', rootPath: '/path/to/pylon-design', createdAt: QA_NOW - 72 * HOUR, lastActiveAt: QA_NOW - 2 * HOUR, skills: ['design-system'], mcpServerIds: ['browser'], hookPluginIds: ['builtin.skin'] },
    { id: 'w-worldbook', agentId: 'gm', name: '世界书', rootPath: '/path/to/worldbook', createdAt: QA_NOW - 120 * HOUR, lastActiveAt: QA_NOW - 6 * HOUR, skills: ['writing'], mcpServerIds: [], hookPluginIds: [] },
    { id: 'w-operations', agentId: 'hermes', name: 'Hermes Operations', rootPath: '/path/to/ops', createdAt: QA_NOW - 200 * HOUR, lastActiveAt: QA_NOW - 8 * HOUR, skills: ['deploy'], mcpServerIds: ['sentry'], hookPluginIds: [] },
    { id: 'w-plugin-lab', agentId: 'claude', name: '插件实验室 · GUI Renderer', rootPath: '/path/to/gui-renderer', createdAt: QA_NOW - 48 * HOUR, lastActiveAt: QA_NOW - 4 * HOUR, skills: ['plugin-api'], mcpServerIds: ['filesystem'], hookPluginIds: ['visual.capture'] },
    { id: 'w-sandbox', agentId: 'pi', name: '空工作区 / Empty State', rootPath: '/path/to/sandbox', createdAt: QA_NOW - 12 * HOUR, lastActiveAt: QA_NOW - 10 * HOUR, skills: [], mcpServerIds: [], hookPluginIds: [] },
    { id: 'w-long-path', agentId: 'peri', name: '超长路径与截断行为验收工作区', rootPath: '/Company/Research/2026/Extremely-Long-Workspace-Name/Packages/Desktop-Experience/Pylon', createdAt: QA_NOW - 300 * HOUR, lastActiveAt: QA_NOW - 20 * HOUR, skills: [], mcpServerIds: [], hookPluginIds: [] },
  ]
}

/** 设置 → 插件页专用：覆盖不同 kind、版本、体积与启停状态。默认全部停用，避免 Mock 包尝试加载不存在的 JS。 */
export function buildVisualQaPluginPackages(): InstalledPluginPackage[] {
  const packages = [
    { id: 'lab.gui-renderer', name: 'GUI 化消息渲染', version: '0.8.2', kind: 'renderer', bytes: 2_486_320, files: 14 },
    { id: 'lab.workspace-insights', name: '工作区洞察面板', version: '1.3.0-beta.2', kind: 'feature', bytes: 684_112, files: 9 },
    { id: 'studio.aurora-skin', name: 'Aurora Glass 主题包', version: '2.1.4', kind: 'skin', bytes: 4_927_408, files: 27 },
    { id: 'ops.acp-observer', name: 'ACP Runtime Observer', version: '0.5.1', kind: 'service', bytes: 318_744, files: 6 },
  ] as const
  return packages.map(item => ({
    enabled: false,
    package: {
      pluginId: item.id,
      version: item.version,
      packageInstanceId: `${item.id}@${item.version}-visual-qa`,
      active: false,
      totalBytes: item.bytes,
      files: Array.from({ length: item.files }, (_, index) => ({
        path: index === 0 ? 'pylon-plugin.json' : index === 1 ? 'dist/entry.js' : `assets/mock-${index}.dat`,
        size: index === 0 ? 512 : Math.floor(item.bytes / item.files),
        mime: index === 0 ? 'application/json' : index === 1 ? 'text/javascript' : 'application/octet-stream',
      })),
      manifest: {
        schema: 1,
        id: item.id,
        name: item.name,
        version: item.version,
        api: '1.0',
        kind: item.kind,
        web: { entry: './dist/entry.js', styles: ['./dist/styles.css'] },
        activation: { events: ['onSettings'] },
        hotSwap: { mode: item.kind === 'service' ? 'exclusive' : 'soft-remount' },
      },
    },
  }))
}

function msg(sessionId: string, index: number, role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return {
    id: `${role}-${sessionId}-${index}`,
    role,
    sender: role === 'user' ? 'local:visual-qa' : role === 'tool' ? `tool:${extra.toolName ?? 'Unknown'}` : sessionId.includes('gm') || sessionId.includes('i18n') ? 'gm' : 'peri',
    content,
    time: `${String(9 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`,
    ...extra,
  }
}

function longContextMessages(sessionId: string): Message[] {
  const topics = [
    ['插件边界', 'Registry 是运行时事实源，产品组件不维护第二份 contribution 映射。'],
    ['状态归属', 'Workspace、Session 与 AgentContext 必须保持可追踪 owner，切换时不串 source。'],
    ['渲染策略', 'Presentation Profile 与 Renderer Engine 正交，视觉风格不能绑定 React 或 Solid。'],
    ['错误隔离', '单个插件 Surface 失败时只熔断自身，主 Sheet 和其他 contribution 继续工作。'],
    ['持久化', '写盘采用完整 next snapshot；失败必须保留内存操作并展示可见警告。'],
    ['性能', '长消息、工具输出和 Markdown 解析都需要 memo、懒加载与稳定 identity。'],
  ] as const
  return Array.from({ length: 36 }, (_, index) => {
    const [title, body] = topics[index % topics.length]
    if (index % 3 === 0) return msg(sessionId, index, 'user', `第 ${index / 3 + 1} 轮：请复核「${title}」，并指出它与上一轮结论是否冲突。`)
    if (index % 3 === 1) return msg(sessionId, index, 'reasoning', `${body}\n\n需要同时核对生命周期、测试证据与插件停用后的 UI 消失行为。`, { thoughtStartedAt: QA_NOW - 8_000, thoughtDurationMs: 6_000 + index * 40 })
    return msg(sessionId, index, 'assistant', `### ${title}\n\n${body}\n\n- 当前结论：边界清晰\n- 回归风险：中等\n- 下一证据：运行 owner/scope/shadow 生命周期测试\n\n> 这是用于观察长会话节奏、标题层级和滚动性能的第 ${index + 1} 条消息。`)
  })
}

function taskSwarmMessages(sessionId: string): Message[] {
  const states = ['completed', 'in_progress', 'waiting', 'queued', 'failed', 'cancelled', 'future-status']
  const tools = ['Read', 'Grep', 'Bash', 'Edit', 'Task', 'Fetch', 'Browser']
  const messages: Message[] = [
    msg(sessionId, 0, 'user', '并行检查设计 Token、FileSheet、设置页、插件页和浅色模式；保留所有状态供视觉验收。'),
    msg(sessionId, 1, 'reasoning', '将任务拆成多个互不写同一文件的分支，并展示等待、排队、失败、取消和未知状态。', { thoughtStartedAt: QA_NOW - 12_000, thoughtDurationMs: 12_000 }),
  ]
  for (let index = 0; index < 21; index += 1) {
    const status = states[index % states.length]
    const toolName = tools[index % tools.length]
    messages.push(msg(sessionId, index + 2, 'tool', '', {
      toolName,
      toolKind: toolName === 'Grep' ? 'search' : toolName === 'Task' ? 'plan' : toolName === 'Edit' ? 'edit' : toolName === 'Bash' ? 'execute' : 'read',
      toolInput: `视觉验收分支 ${String(index + 1).padStart(2, '0')} · ${toolName}`,
      toolOutput: status === 'failed' ? 'Error: contribution render failed; isolated boundary kept host alive' : `branch-${index + 1}: ${status}\nowner=builtin.visual-qa\nduration=${120 + index * 17}ms`,
      toolOutputLines: 3,
      toolStatus: status,
      running: status === 'in_progress',
    }))
  }
  messages.push(msg(sessionId, 23, 'assistant', '并行矩阵已铺满。重点检查连接线、状态色、长列表密度，以及失败项是否抢占了过多视觉注意力。'))
  return messages
}

export function buildVisualQaMessages(sessionId: string): Message[] {
  switch (sessionId) {
    case 'demo-visual-matrix':
      return createMockMessages()
    case 'demo-long-context':
      return longContextMessages(sessionId)
    case 'demo-task-swarm':
      return taskSwarmMessages(sessionId)
    case 'demo-empty':
      return []
    case 'demo-design-audit':
      return [
        msg(sessionId, 0, 'user', '从用户视角审查设置页：层级、对齐、字体、圆角和玻璃效果都要给出明确结论。'),
        msg(sessionId, 1, 'reasoning', '先建立视觉层级：Canvas → Panel → Raised → Overlay；再检查每个分区是否滥用卡片和等宽字体。', { thoughtStartedAt: QA_NOW - 7_200, thoughtDurationMs: 7_200 }),
        msg(sessionId, 2, 'tool', '', { toolName: 'Browser', toolKind: 'browser', toolInput: 'capture settings / global / dark', toolOutput: 'viewport 1280×720\ncontrast warnings: 2\nalignment deviations: 4', toolOutputLines: 3, toolStatus: 'completed' }),
        msg(sessionId, 3, 'assistant', '## 设置页审计\n\n| 维度 | 结论 |\n|---|---|\n| 字体 | 普通说明使用 UI 字体；路径和数值保留等宽 |\n| 圆角 | 分组只使用 6px，按钮不再层层胶囊 |\n| 材质 | 页面、导航、字段组形成三级表面 |\n| 对齐 | 标签列与控件基线统一 |\n\n下一步优先处理插件页的信息密度。'),
      ]
    case 'demo-mobile-layout':
      return [
        msg(sessionId, 0, 'user', '在 900、680 和 480 像素宽度检查标题、工具卡、输入栏与右栏。'),
        msg(sessionId, 1, 'tool', '', { toolName: 'Browser', toolKind: 'browser', toolInput: 'responsive sweep: 1280 → 900 → 680 → 480', toolOutput: '1280 PASS\n900 PASS\n680 right panel collapsed\n480 long title ellipsized', toolOutputLines: 4, toolStatus: 'completed' }),
        msg(sessionId, 2, 'assistant', '窄屏策略应优先保住内容与输入：隐藏非关键品牌副文案，Sheet 标签允许滚动，右栏自动收起，任何按钮的可点击区域不得小于 28px。'),
      ]
    case 'demo-i18n':
      return [
        msg(sessionId, 0, 'user', '检查混合语言排版：Pylon 工作台 / Agent runtime / エージェント / وكيل。'),
        msg(sessionId, 1, 'assistant', '# 多语言基线\n\n中文标点：你好，世界。\n\nEnglish: The quick brown fox jumps over the lazy dog.\n\n日本語：エージェントがワークスペースを確認しています。\n\nالعربية: يعمل الوكيل داخل مساحة العمل.\n\nEmoji：🧭 🧩 🛠️ ✅ ⚠️\n\n`/Project/包含中文/very-long-file-name.tsx`\n\n混排时普通正文跟随 UI 字体，只有路径与代码保持等宽。'),
        msg(sessionId, 2, 'assistant', '长词压力：`SupercalifragilisticexpialidociousWithoutAnyBreakOpportunity` 应换行或安全截断，不能撑破消息列。'),
      ]
    case 'demo-error-recovery':
      return [
        msg(sessionId, 0, 'user', '发布失败了，先保留现场，再执行安全回滚。'),
        msg(sessionId, 1, 'tool', '', { toolName: 'Bash', toolKind: 'execute', toolInput: 'deploy --environment production', toolOutput: '\u001b[31mERROR\u001b[0m health check failed: HTTP 503\nrelease=pylon-2026.08.19.4', toolOutputLines: 2, toolStatus: 'failed' }),
        msg(sessionId, 2, 'reasoning', '发布失败但旧实例仍健康。先收集日志和 active pointer，再回滚，不执行清理命令。', { thoughtStartedAt: QA_NOW - 4_500, thoughtDurationMs: 4_500 }),
        msg(sessionId, 3, 'tool', '', { toolName: 'Bash', toolKind: 'execute', toolInput: 'pylon-cli package rollback gui.renderer --package-instance-id stable-3', toolOutput: 'active pointer → stable-3\nhealth check: 200 OK', toolOutputLines: 2, toolStatus: 'completed' }),
        msg(sessionId, 4, 'assistant', '恢复完成。失败发布保留为不可变版本，当前指针已回到 `stable-3`。错误卡应清晰可见，但成功恢复必须成为最终视觉焦点。'),
      ]
    case 'demo-plugin-authoring':
      return [
        msg(sessionId, 0, 'user', '创建一个 GUI 化消息渲染插件，同时贡献自己的设置页面。'),
        msg(sessionId, 1, 'reasoning', '插件需要分别注册 Renderer Engine、Presentation Profile 和 Settings Page；三者不能合成一个硬编码组件。', { thoughtStartedAt: QA_NOW - 9_000, thoughtDurationMs: 9_000 }),
        msg(sessionId, 2, 'tool', '', { toolName: 'Write', toolKind: 'write', toolInput: 'pylon-plugin.json', toolOutput: '{ "id": "lab.gui-renderer", "api": "1.0", "kind": "renderer" }', toolOutputLines: 1, toolStatus: 'completed' }),
        msg(sessionId, 3, 'tool', '', { toolName: 'Edit', toolKind: 'edit', toolInput: 'src/entry.ts', toolOutput: 'registered renderer: lab.gui.cards\nregistered profile: lab.gui.soft\nregistered settings page: GUI 化渲染', toolOutputLines: 3, toolStatus: 'completed' }),
        msg(sessionId, 4, 'assistant', '插件已注册三个独立贡献点。停用插件后，渲染器、风格选项和设置页面会一同从各自 Registry 消失。'),
      ]
    case 'demo-unbound':
      return [
        msg(sessionId, 0, 'assistant', '这是一个未绑定 Workspace 的旧会话，用于验收侧栏中的“未归类会话”与 FileSheet 无根目录空态。'),
      ]
    default:
      return []
  }
}
