import { ErrorBoundary, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { buildChatRowDescriptors } from '../../components/chat/chatRowPipeline.ts'
import { buildMessageLookups } from '../../components/chat/messageLookups.ts'
import { prepareMessages } from '../../components/chat/messagePipeline.ts'
import type { Message, RenderMessage } from '../../components/chat/messageTypes.ts'
import type { MessageListItem } from '../../domains/workbench/messageListPort.ts'
import { createToolConnectorLayoutPort } from '../../domains/workbench/toolConnectorLayoutPort.ts'
import { AssistantContent, SolidMessageRow } from './chat/MessageRow.solid.tsx'
import { PlainMessageList } from './chat/PlainMessageList.solid.tsx'
import { SolidTaskTree } from './chat/TaskTree.solid.tsx'
import { SolidToolCard } from './chat/ToolCard.solid.tsx'
import { SolidToolConnector } from './chat/ToolConnector.solid.tsx'
import { SolidGenerationFooter } from './chat/GenerationFooter.solid.tsx'
import { SolidInputBar } from './input/InputBar.solid.tsx'
import { SolidAttachWidget, SolidModeWidget, SolidModelWidget, SolidSendWidget } from './input/WorkbenchWidgets.solid.tsx'
import { SolidWorkbenchContext, type SolidWorkbenchContextValue } from './SolidWorkbenchContext.solid.tsx'
import { getMessageRendererSnapshot, subscribeMessageRenderers } from '../../host/messageRendererResolver.ts'

export interface SolidWorkbenchAppProps {
  context: SolidWorkbenchContextValue
}

export function SolidWorkbenchApp(props: SolidWorkbenchAppProps) {
  return (
    <SolidWorkbenchContext.Provider value={props.context}>
      <ErrorBoundary fallback={error => (
        <div class="solid-workbench-error" role="alert">
          Agent 工作台加载失败：{error instanceof Error ? error.message : String(error)}
        </div>
      )}>
        <WorkbenchContent context={props.context} />
      </ErrorBoundary>
    </SolidWorkbenchContext.Provider>
  )
}

function WorkbenchContent(props: SolidWorkbenchAppProps) {
  const snapshot = () => props.context.runtimeSnapshot()
  const appearance = () => props.context.appearanceSnapshot()
  const connectorPort = createToolConnectorLayoutPort()
  let messageListPort: import('../../domains/workbench/messageListPort.ts').MessageListPort | undefined
  onCleanup(() => connectorPort.destroy())
  const renderMessages = createMemo(() => prepareMessages([...snapshot().messages]))
  const descriptors = createMemo(() => buildChatRowDescriptors(
    renderMessages(),
    buildMessageLookups(snapshot().messages),
    undefined,
  ))
  const items = createMemo<readonly MessageListItem[]>(() => descriptors().map(descriptor => ({
    key: descriptor.key,
    descriptor,
  })))
  createEffect(() => messageListPort?.setItems(items()))
  // M4：Solid host 同样只经 registry 查询 renderer 能力（零视觉变化）。
  const [rendererSnapshot, setRendererSnapshot] = createSignal(getMessageRendererSnapshot())
  onCleanup(subscribeMessageRenderers(() => setRendererSnapshot(getMessageRendererSnapshot())))
  const messageRendererIds = () => rendererSnapshot().messageRenderers.map(entry => entry.value.renderer.rendererId)

  return (
    <section
      class="solid-agent-workbench"
      data-renderer="solid"
      data-message-renderer={messageRendererIds().join(',')}
      data-preview={props.context.input().preview ? 'true' : 'false'}
      data-paused={props.context.paused() ? 'true' : 'false'}
      data-session-id={props.context.input().sessionId ?? undefined}
      data-status={snapshot().status}
      style={{ '--right-inset': `${Math.max(0, props.context.input().rightInset ?? 0)}px` }}
      aria-label="Solid Agent Workbench"
    >
      <Show when={snapshot().status === 'error'}>
        <div class="solid-workbench-runtime-error" role="alert">{snapshot().error || '工作台运行时错误'}</div>
      </Show>
      <Show
        when={props.context.input().sessionId}
        fallback={<WorkbenchEmptyState status={snapshot().status} />}
      >
        <div class="chat-view solid-workbench-chat">
          <div class="term">
            <PlainMessageList
              initialItems={items()}
              renderItem={item => <WorkbenchRow
                descriptor={item.descriptor}
                messages={snapshot().messages}
                appearance={appearance()}
                connectorPort={connectorPort}
              />}
              onPortReady={port => {
                messageListPort = port
                port.setItems(items())
              }}
            />
            <Show when={snapshot().streamingThinking}>
              {text => <div class="term-row term-row-reasoning" data-render-type="reasoning">
                <div class="term-reasoning" data-state="running">{text()}</div>
              </div>}
            </Show>
            <Show when={snapshot().streamingText}>
              {text => <div class="term-row term-row-assistant" data-render-type="assistant">
                <AssistantContent text={text()} appearance={appearance()} streaming />
              </div>}
            </Show>
            <SolidGenerationFooter
              running={snapshot().generating}
              tokenCount={snapshot().tokenCount}
              startTime={snapshot().generationStart}
              lastTokenAt={snapshot().lastTokenAt}
              summary={snapshot().summary}
              phase={snapshot().generationPhase}
              thinkingStart={snapshot().thinkingStart}
              activeTaskContent={snapshot().tasks.find(task => task.status === 'in_progress')?.content}
              appearance={appearance().spinner}
              reducedMotion={props.context.input().reducedMotion}
              onStop={props.context.input().preview ? undefined : () => {
                const sessionId = props.context.input().sessionId
                if (sessionId) void props.context.commands.cancel(sessionId)
              }}
            />
          </div>
          <SolidTaskTree sessionId={props.context.input().sessionId} tasks={snapshot().tasks} />
        </div>
        <Show when={appearance().showPet}>
          <div class="solid-workbench-pet-slot pet-companion" data-fixture="pending">Pet fixture slot</div>
        </Show>
        <Show when={!props.context.input().replayReadonly}>
          <div class="solid-workbench-control-center-slot control-center" data-fixture="widgets">
            <div class="solid-workbench-widget-strip">
              <SolidModelWidget />
              <SolidModeWidget />
              <SolidAttachWidget />
              <SolidSendWidget />
            </div>
            <SolidInputBar
              externalSend={appearance().inputSubmitButtonMode === 'external'}
              externalAttach={appearance().inputSubmitButtonMode === 'external'}
            />
          </div>
        </Show>
        <Show when={props.context.input().replayReadonly}>
          <div class="solid-workbench-replay-overlay" role="status">历史回放 · 只读</div>
        </Show>
      </Show>
    </section>
  )
}

function WorkbenchEmptyState(props: { status: string }) {
  return (
    <div class="solid-workbench-empty" data-status={props.status}>
      <strong>Pylon</strong>
      <span>{props.status === 'loading' ? '正在加载会话…' : '选择或创建一个 Session'}</span>
    </div>
  )
}

function WorkbenchRow(props: {
  descriptor: MessageListItem['descriptor']
  messages: readonly Message[]
  appearance: SolidWorkbenchContextValue['appearanceSnapshot'] extends () => infer T ? T : never
  connectorPort: ReturnType<typeof createToolConnectorLayoutPort>
}) {
  const current = () => props.descriptor.renderMessage
  const previousTool = () => {
    if (!props.descriptor.showConnector) return undefined
    const index = props.messages.findIndex(message => message.id === current().message.id)
    return index > 0 ? props.messages[index - 1] : undefined
  }
  const visualState = () => normalizeToolVisualState(props.descriptor.toolVisualState)
  const connectorVisualState = () => normalizeToolVisualState(props.descriptor.connectorVisualState)

  return (
    <>
      <Show when={props.descriptor.showConnector && previousTool()}>
        {previous => <SolidToolConnector
          connectorKey={`${previous().id}->${current().message.id}`}
          fromMessageId={previous().id}
          toMessageId={current().message.id}
          status={props.descriptor.connectorStatus ?? 'run'}
          visualState={connectorVisualState()}
          appearance={props.appearance}
          layoutPort={props.connectorPort}
        />}
      </Show>
      <Show
        when={current().type === 'tool_call' || current().type === 'tool_result'}
        fallback={<SolidMessageRow
          renderMessage={current()}
          appearance={props.appearance}
          highlighted={props.descriptor.isSearchMatch}
        />}
      >
        <div class="term-row term-row-tool" data-render-type={current().type}>
          <SolidToolCard
            message={current().message}
            visualState={visualState()}
            appearance={props.appearance}
            messageId={current().message.id}
            layoutPort={props.connectorPort}
          />
        </div>
      </Show>
    </>
  )
}

function normalizeToolVisualState(value: string | undefined) {
  switch (value) {
    case 'queued':
    case 'waiting':
    case 'running':
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'unknown':
      return value
    default:
      return undefined
  }
}

export function previewRenderMessages(messages: readonly Message[]): readonly RenderMessage[] {
  return prepareMessages([...messages])
}
