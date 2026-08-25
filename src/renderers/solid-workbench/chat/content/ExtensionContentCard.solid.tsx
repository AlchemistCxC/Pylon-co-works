import { For, Show } from 'solid-js'
import type { RenderAppearanceSnapshot, RenderCommandPort } from '../../../../contracts/messageRenderer.ts'
import {
  coalesceAdjacentDisplayTextParts,
  isValidArtifactContentInput,
  isValidHookSurfaceInput,
  isValidMcpResourceContentInput,
  isValidMemoryContentInput,
  isValidSkillContentInput,
  type ArtifactContentPart,
  type ContentPart,
  type HookSurfaceSnapshot,
  type McpResourceContentPart,
  type MemoryContentPart,
  type SkillContentPart,
} from '../../../../domains/workbench/content/contentPartSchema.ts'
import { ToolContentPart } from '../ToolInvocationCard.solid.tsx'
import { ToolObjectInspector } from '../tool/ToolObjectInspector.solid.tsx'

export type ExtensionRenderKind =
  | 'content.memory'
  | 'content.skill'
  | 'content.mcp-resource'
  | 'content.artifact'
  | 'system.hook'

export function SolidExtensionContentCard(props: {
  kind: ExtensionRenderKind
  payload: unknown
  appearance?: RenderAppearanceSnapshot
  commands?: RenderCommandPort
}) {
  const appearance = () => props.appearance ?? {}
  const fields = () => multiSetting(appearance(), 'metadataFields', ['identity', 'source', 'status', 'owner'])

  if (props.kind === 'system.hook') {
    return <Show when={isValidHookSurfaceInput(props.payload) ? props.payload : undefined}
      fallback={<InvalidExtension kind={props.kind} />}>
      {hook => <HookCard hook={hook()} appearance={appearance()} fields={fields()}
        palette={stringSetting(appearance(), 'categoryPalette', 'semantic')}
        icon={stringSetting(appearance(), 'icon', 'auto')} />}
    </Show>
  }

  return <Show when={validatedContent(props.kind, props.payload)} fallback={<InvalidExtension kind={props.kind} />}>
    {content => <TypedExtensionCard content={content()} appearance={appearance()} commands={props.commands} />}
  </Show>
}

function TypedExtensionCard(props: {
  content: MemoryContentPart | SkillContentPart | McpResourceContentPart | ArtifactContentPart
  appearance: RenderAppearanceSnapshot
  commands?: RenderCommandPort
}) {
  const uri = () => props.content.kind === 'mcp-resource' ? props.content.resourceUri
    : props.content.kind === 'artifact' ? props.content.uri
      : props.content.kind === 'skill' ? props.content.uri : undefined
  const title = () => contentTitle(props.content)
  const fields = () => multiSetting(props.appearance, 'metadataFields', ['identity', 'source', 'status', 'owner'])
  const can = (type: string) => props.commands?.canExecute?.(type) === true
  const execute = (type: string, payload: unknown) => { void props.commands?.execute({ type, payload }) }
  const canDownload = () => props.content.kind === 'artifact'
    && (props.content.hasBlob === true || props.content.actions?.includes('download') === true)

  return (
    <article
      class="solid-extension-card"
      aria-label={`${categoryLabel(props.content.kind)}：${title()}`}
      data-content-kind={`content.${props.content.kind}`}
      data-status={props.content.status ?? (props.content.kind === 'mcp-resource' ? props.content.connectionState : undefined)}
      data-category-palette={stringSetting(props.appearance, 'categoryPalette', 'semantic')}
      data-icon={stringSetting(props.appearance, 'icon', 'auto')}
      data-reduced-motion={props.appearance.reducedMotion === true ? 'true' : 'false'}
    >
      <header>
        <span class="solid-extension-icon" data-icon={stringSetting(props.appearance, 'icon', 'auto')} aria-hidden="true">
          {extensionIconGlyph(stringSetting(props.appearance, 'icon', 'auto'), props.content.kind)}
        </span>
        <div class="solid-extension-title">
          <span class="solid-extension-kind">{categoryLabel(props.content.kind)}</span>
          <strong>{title()}</strong>
        </div>
        <Show when={props.content.kind === 'mcp-resource' && booleanSetting(props.appearance, 'mcpServerBadge', true)}>
          <span class="solid-extension-server-badge">{(props.content as McpResourceContentPart).server}</span>
        </Show>
        <Show when={props.content.status ?? (props.content.kind === 'mcp-resource' ? props.content.connectionState : undefined)}>
          {status => <span class="solid-extension-status">{status()}</span>}
        </Show>
      </header>
      <Metadata content={props.content} fields={props.content.kind === 'mcp-resource' && booleanSetting(props.appearance, 'mcpServerBadge', true)
        ? fields().filter(field => field !== 'server')
        : fields()} />
      <Show when={props.content.summary}><p>{props.content.summary}</p></Show>
      <Show when={props.content.kind === 'artifact' && props.content.parts?.length}>
        <div class="solid-extension-preview" style={{ 'max-height': `${boundedNumber(props.appearance, 'artifactPreviewSize', 320, 80, 1200)}px`, overflow: 'auto' }}>
          <For each={coalesceAdjacentDisplayTextParts((props.content as ArtifactContentPart).parts ?? [])}>{(part, index) => <ToolContentPart
            part={part} appearance={props.appearance} commands={props.commands}
            nodeId={`${(props.content as ArtifactContentPart).artifactId}:part:${index()}`}
          />}</For>
        </div>
      </Show>
      <Show when={uri()}>
        {value => <code class="solid-extension-uri">{value()}</code>}
      </Show>
      <Show when={uri() && (can('resource.open') || can('clipboard.write'))}>
        <div class="solid-extension-actions">
          <Show when={can('resource.open')}>
            <button type="button" onClick={() => execute('resource.open', { uri: uri() })}>
              {props.content.kind === 'mcp-resource' ? '打开 MCP 资源' : '打开工件'}
            </button>
          </Show>
          <Show when={can('clipboard.write')}>
            <button type="button" onClick={() => execute('clipboard.write', { text: uri() })}>
              {props.content.kind === 'mcp-resource' ? '复制 MCP 资源地址' : '复制工件地址'}
            </button>
          </Show>
          <Show when={canDownload() && can('resource.open')}>
            <button type="button" onClick={() => execute('resource.open', { uri: uri(), disposition: 'download' })}>下载工件</button>
          </Show>
        </div>
      </Show>
      <Show when={props.content.raw && Object.keys(props.content.raw).length > 0}>
        <details open={!booleanSetting(props.appearance, 'unknownRawCollapsed', true)}>
          <summary>未知元数据</summary>
          <ToolObjectInspector value={props.content.raw} commands={props.commands} />
        </details>
      </Show>
    </article>
  )
}

function HookCard(props: {
  hook: HookSurfaceSnapshot
  appearance: RenderAppearanceSnapshot
  fields: readonly string[]
  palette: string
  icon: string
}) {
  const showDuration = () => booleanSetting(props.appearance, 'showDuration', true)
  return (
    <section
      class="solid-extension-card solid-hook-card"
      role="status"
      aria-label={`Hook：${props.hook.phase}`}
      data-content-kind="system.hook"
      data-category-palette={props.palette}
      data-icon={props.icon}
      data-status={props.hook.status}
    >
      <header>
        <span class="solid-extension-icon" data-icon={props.icon} aria-hidden="true">{extensionIconGlyph(props.icon, 'hook')}</span>
        <strong>{props.hook.phase}</strong>
      </header>
      <details open={!booleanSetting(props.appearance, 'defaultCollapsed', true)}>
        <summary>{props.hook.status}</summary>
        <dl>
          <Show when={props.fields.includes('owner')}><dt>所有者</dt><dd>{props.hook.owner.pluginId} · {props.hook.owner.handlerId}</dd></Show>
          <Show when={props.fields.includes('status')}><dt>状态</dt><dd>{props.hook.status}</dd></Show>
          <Show when={showDuration() && props.hook.durationMs !== undefined}><dt>耗时</dt><dd>{props.hook.durationMs} ms</dd></Show>
          <Show when={props.hook.decision}><dt>决策</dt><dd>{props.hook.decision}</dd></Show>
        </dl>
        <Show when={props.hook.error}>{error => <p role="alert">{error().code ? `${error().code}：` : ''}{error().message}</p>}</Show>
        <Show when={props.hook.raw && Object.keys(props.hook.raw).length > 0}>
          <details open={!booleanSetting(props.appearance, 'unknownRawCollapsed', true)}><summary>未知元数据</summary><ToolObjectInspector value={props.hook.raw} /></details>
        </Show>
      </details>
    </section>
  )
}

function Metadata(props: { content: MemoryContentPart | SkillContentPart | McpResourceContentPart | ArtifactContentPart; fields: readonly string[] }) {
  const rows = () => metadataRows(props.content).filter(([key]) => props.fields.includes(key))
  return <Show when={rows().length > 0}><dl class="solid-extension-metadata"><For each={rows()}>{([, label, value]) => <><dt>{label}</dt><dd>{value}</dd></>}</For></dl></Show>
}

function metadataRows(content: MemoryContentPart | SkillContentPart | McpResourceContentPart | ArtifactContentPart): readonly [string, string, string][] {
  const rows: [string, string, string][] = []
  const add = (key: string, label: string, value: unknown) => { if (value !== undefined && value !== '') rows.push([key, label, String(value)]) }
  if (content.kind === 'memory') { add('identity', 'ID', content.memoryId); add('source', '来源', content.source); add('scope', '范围', content.scope) }
  if (content.kind === 'skill') { add('identity', 'ID', content.skillId); add('source', '来源', content.source); add('scope', '范围', content.scope) }
  if (content.kind === 'mcp-resource') { add('server', '服务器', content.server); add('tool', '工具', content.tool) }
  if (content.kind === 'artifact') add('identity', 'ID', content.artifactId)
  add('status', '状态', content.status ?? (content.kind === 'mcp-resource' ? content.connectionState : undefined))
  add('version', '版本', 'version' in content ? content.version : undefined)
  add('mime', 'MIME', 'mimeType' in content ? content.mimeType : undefined)
  return rows
}

function InvalidExtension(props: { kind: string }) {
  return <pre class="solid-content-unknown" data-content-kind={props.kind}>Invalid {props.kind} payload</pre>
}

function validatedContent(kind: ExtensionRenderKind, payload: unknown): MemoryContentPart | SkillContentPart | McpResourceContentPart | ArtifactContentPart | undefined {
  if (kind === 'content.memory' && isValidMemoryContentInput(payload)) return payload
  if (kind === 'content.skill' && isValidSkillContentInput(payload)) return payload
  if (kind === 'content.mcp-resource' && isValidMcpResourceContentInput(payload)) return payload
  if (kind === 'content.artifact' && isValidArtifactContentInput(payload)) return payload
  return undefined
}

function contentTitle(content: MemoryContentPart | SkillContentPart | McpResourceContentPart | ArtifactContentPart): string {
  if (content.kind === 'mcp-resource') return content.title ?? content.resourceUri
  return content.title
}

function categoryLabel(kind: ContentPart['kind']): string {
  if (kind === 'memory') return '记忆'
  if (kind === 'skill') return '技能'
  if (kind === 'mcp-resource') return 'MCP 资源'
  return '工件'
}

function extensionIconGlyph(icon: string, kind: ContentPart['kind'] | 'hook'): string {
  const resolved = icon === 'auto'
    ? kind === 'memory' ? 'memory' : kind === 'skill' ? 'skill' : kind === 'mcp-resource' ? 'server' : kind === 'hook' ? 'hook' : 'document'
    : icon
  if (resolved === 'memory') return '◫'
  if (resolved === 'skill') return '✦'
  if (resolved === 'server') return '⛁'
  if (resolved === 'hook') return '⤴'
  return '▣'
}

function stringSetting(appearance: RenderAppearanceSnapshot, key: string, fallback: string): string {
  return typeof appearance[key] === 'string' && appearance[key] ? appearance[key] as string : fallback
}

function booleanSetting(appearance: RenderAppearanceSnapshot, key: string, fallback: boolean): boolean {
  return typeof appearance[key] === 'boolean' ? appearance[key] as boolean : fallback
}

function multiSetting(appearance: RenderAppearanceSnapshot, key: string, fallback: readonly string[]): readonly string[] {
  const value = appearance[key]
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : fallback
}

function boundedNumber(appearance: RenderAppearanceSnapshot, key: string, fallback: number, min: number, max: number): number {
  const value = appearance[key]
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}
