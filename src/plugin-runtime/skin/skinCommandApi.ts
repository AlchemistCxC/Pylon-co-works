/**
 * skinCommandApi — Skin 闭环的 v2 Command 定义（阶段 5 S5-E）。
 *
 * 只返回可序列化 JSON contract；handler 只调用 SkinRuntime/SkinApi，
 * 不直接操作 DOM 或 localStorage。inspect-computed / capture 经注入 port 读取
 * 真实宿主能力；未安装 port 时返回 structured unsupported，不伪造证据。
 */
import type { CommandDefinition } from '../commands/commandRegistry.ts'
import type {
  CaptureOptions,
  CaptureResult,
  ComputedSkinInspection,
  CreateSkinDraftInput,
  SkinPatch,
  SkinTarget,
} from './skinTypes.ts'
import type { SkinRuntime, SkinRollbackResult } from './skinRuntime.ts'

export interface SkinInspectionPort {
  inspectComputed(previewId: string): Promise<ComputedSkinInspection> | ComputedSkinInspection
}

export interface SkinCapturePort {
  capture(previewId: string, options?: CaptureOptions): Promise<CaptureResult> | CaptureResult
}

export interface SkinCommandPorts {
  inspectionPort?: SkinInspectionPort
  capturePort?: SkinCapturePort
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function parseTarget(value: unknown): SkinTarget {
  const record = asRecord(value)
  switch (record.scope) {
    case 'global':
      return { scope: 'global' }
    case 'workspace':
      if (typeof record.workspaceId === 'string' && record.workspaceId) {
        return { scope: 'workspace', workspaceId: record.workspaceId }
      }
      throw new Error('workspace target 需要 workspaceId')
    case 'agent':
      if (typeof record.agentId === 'string' && record.agentId) {
        return { scope: 'agent', agentId: record.agentId }
      }
      throw new Error('agent target 需要 agentId')
    case 'session':
      if (typeof record.sessionId === 'string' && record.sessionId) {
        return { scope: 'session', sessionId: record.sessionId }
      }
      throw new Error('session target 需要 sessionId')
    default:
      throw new Error(`非法 SkinTarget：${JSON.stringify(value)}`)
  }
}

function parseDraftId(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('draftId 必须是非空字符串')
  return value
}

function parsePreviewId(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('previewId 必须是非空字符串')
  return value
}

function parseCreateDraftInput(value: unknown): CreateSkinDraftInput {
  const record = asRecord(value)
  if (typeof record.name !== 'string' || !record.name.trim()) throw new Error('name 必须是非空字符串')
  const input: CreateSkinDraftInput = { name: record.name }
  if (typeof record.baseSkinId === 'string' && record.baseSkinId) input.baseSkinId = record.baseSkinId
  if (record.tokens && typeof record.tokens === 'object' && !Array.isArray(record.tokens)) input.tokens = record.tokens as Record<string, unknown>
  if (record.variants && typeof record.variants === 'object' && !Array.isArray(record.variants)) input.variants = record.variants as Record<string, string>
  if (typeof record.css === 'string') input.css = record.css
  return input
}

function parsePatch(value: unknown): SkinPatch {
  const record = asRecord(value)
  const patch: SkinPatch = {}
  if (record.tokens !== undefined) {
    if (!record.tokens || typeof record.tokens !== 'object' || Array.isArray(record.tokens)) throw new Error('patch.tokens 必须是对象')
    patch.tokens = record.tokens as Record<string, unknown>
  }
  if (record.variants !== undefined) {
    if (!record.variants || typeof record.variants !== 'object' || Array.isArray(record.variants)) throw new Error('patch.variants 必须是对象')
    patch.variants = record.variants as Record<string, string>
  }
  if (record.css !== undefined) {
    if (typeof record.css !== 'string') throw new Error('patch.css 必须是 string')
    patch.css = record.css
  }
  return patch
}

export function createSkinCommandDefinitions(
  runtime: SkinRuntime,
  ports: SkinCommandPorts = {},
): CommandDefinition[] {
  const priorityBase = 800
  const commands: CommandDefinition[] = [
    {
      id: 'skin.schema',
      name: 'skin.schema',
      description: '读取当前动态 Skin Schema（字段、组件 variants、surfaces）',
      priority: priorityBase,
      execute: () => runtime.schemaSnapshot(),
    },
    {
      id: 'skin.inspect',
      name: 'skin.inspect',
      description: '读取指定 target 当前 resolved skin',
      priority: priorityBase + 1,
      inputHint: '{ "target": { "scope": "global" } }',
      execute: ({ args }) => runtime.inspect(parseTarget(asRecord(args).target)),
    },
    {
      id: 'skin.draft.create',
      name: 'skin.draft.create',
      description: '创建 Skin Draft（delta）',
      priority: priorityBase + 2,
      inputHint: '{ "name": "皮肤名", "tokens": { "accent": "#ff0000" } }',
      execute: ({ args }) => runtime.createDraft(parseCreateDraftInput(args)),
    },
    {
      id: 'skin.draft.patch',
      name: 'skin.draft.patch',
      description: '对 Draft 做局部 patch，revision 递增',
      priority: priorityBase + 3,
      inputHint: '{ "draftId": "draft-1", "patch": { "tokens": { "accent": "#00ff00" } } }',
      execute: ({ args }) => {
        const record = asRecord(args)
        return runtime.patchDraft(parseDraftId(record.draftId), parsePatch(record.patch))
      },
    },
    {
      id: 'skin.validate',
      name: 'skin.validate',
      description: '校验 Draft，返回结构化 issues',
      priority: priorityBase + 4,
      inputHint: '{ "draftId": "draft-1" }',
      execute: ({ args }) => runtime.validate(parseDraftId(asRecord(args).draftId)),
    },
    {
      id: 'skin.preview',
      name: 'skin.preview',
      description: '对指定 target 应用 Draft preview',
      priority: priorityBase + 5,
      inputHint: '{ "draftId": "draft-1", "target": { "scope": "global" } }',
      execute: ({ args }) => {
        const record = asRecord(args)
        return runtime.preview(parseDraftId(record.draftId), parseTarget(record.target))
      },
    },
    {
      id: 'skin.preview.patch',
      name: 'skin.preview.patch',
      description: '继续 patch active preview 的 Draft 并重算 resolved',
      priority: priorityBase + 6,
      inputHint: '{ "previewId": "preview-1", "patch": { "tokens": { "accent": "#00ff00" } } }',
      execute: ({ args }) => {
        const record = asRecord(args)
        return runtime.patchPreview(parsePreviewId(record.previewId), parsePatch(record.patch))
      },
    },
    {
      id: 'skin.inspect-computed',
      name: 'skin.inspect-computed',
      description: '读取 preview 的真实 computed style（需要宿主 inspection port）',
      priority: priorityBase + 7,
      inputHint: '{ "previewId": "preview-1" }',
      execute: async ({ args }) => {
        const previewId = parsePreviewId(asRecord(args).previewId)
        if (!ports.inspectionPort) {
          return { supported: false, previewId, error: '宿主未安装 SkinInspectionPort' } satisfies ComputedSkinInspection
        }
        return ports.inspectionPort.inspectComputed(previewId)
      },
    },
    {
      id: 'skin.capture',
      name: 'skin.capture',
      description: '捕获 preview 截图（需要宿主 capture port）',
      priority: priorityBase + 8,
      inputHint: '{ "previewId": "preview-1" }',
      execute: async ({ args }) => {
        const record = asRecord(args)
        const previewId = parsePreviewId(record.previewId)
        const options: CaptureOptions | undefined = record.options && typeof record.options === 'object'
          ? record.options as CaptureOptions
          : undefined
        if (!ports.capturePort) {
          return { supported: false, status: 'unsupported', previewId, error: '宿主未安装 SkinCapturePort' } satisfies CaptureResult
        }
        return ports.capturePort.capture(previewId, options)
      },
    },
    {
      id: 'skin.rollback',
      name: 'skin.rollback',
      description: '撤销 preview，恢复 preview 前 resolved skin',
      priority: priorityBase + 9,
      inputHint: '{ "previewId": "preview-1" }',
      execute: ({ args }): SkinRollbackResult => runtime.rollback(parsePreviewId(asRecord(args).previewId)),
    },
    {
      id: 'skin.commit',
      name: 'skin.commit',
      description: '永久应用 preview（写入 committed skin 与 binding）',
      priority: priorityBase + 10,
      inputHint: '{ "previewId": "preview-1" }',
      execute: ({ args }) => runtime.commit(parsePreviewId(asRecord(args).previewId)),
    },
  ]
  return commands
}
