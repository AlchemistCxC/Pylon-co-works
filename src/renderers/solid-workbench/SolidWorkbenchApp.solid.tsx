/** Workbench composition owner: reactive rows, viewport and mount lifetimes.
 * Value projections live in adjacent modules; they must not create a second runtime store.
 * #228 批次 D：组合实现拆分至 WorkbenchContent / WorkbenchDocumentSurface /
 * CanonicalActivityList / WorkbenchRow / WorkbenchContentSlot（纯搬移，公开导入面不变）。
 */
import { ErrorBoundary } from 'solid-js'
import { SolidWorkbenchContext, type SolidWorkbenchContextValue } from './SolidWorkbenchContext.solid.tsx'
import { prepareMessages } from '../../components/chat/messagePipeline.ts'
import type { Message, RenderMessage } from '../../components/chat/messageTypes.ts'
import { WorkbenchContent } from './WorkbenchContent.solid.tsx'

// Compatibility export for the existing interaction kind contract/tests.
export { interactionRenderKind } from './solidWorkbenchProjectionSupport.ts'

export interface SolidWorkbenchAppProps {
  context: SolidWorkbenchContextValue
}

export function SolidWorkbenchApp(props: SolidWorkbenchAppProps) {
  return (
    <SolidWorkbenchContext.Provider value={props.context}>
      <ErrorBoundary fallback={error => {
        props.context.reportRendererError?.(error)
        return <div class="solid-workbench-error" role="alert">
          Agent 工作台加载失败：{error instanceof Error ? error.message : String(error)}
        </div>
      }}>
        <WorkbenchContent context={props.context} />
      </ErrorBoundary>
    </SolidWorkbenchContext.Provider>
  )
}

export function previewRenderMessages(messages: readonly Message[]): readonly RenderMessage[] {
  return prepareMessages([...messages])
}
