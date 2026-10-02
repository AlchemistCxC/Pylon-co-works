/** @jsxImportSource solid-js */
import { createSignal, onCleanup, Show, type JSX } from 'solid-js'
import type { ApplicationRuntime } from '../application/applicationRuntime.ts'

interface ApplicationMountProps {
  runtime: ApplicationRuntime
  /** recovery 兜底层（Kernel 恢复界面）；无激活应用时渲染。 */
  recovery: JSX.Element
}

/** #515：React → Solid 实体（KernelRoot.solid 直连）。订阅语义与 React useSyncExternalStore 对齐。 */
export default function ApplicationMount(props: ApplicationMountProps): JSX.Element {
  const [snapshot, setSnapshot] = createSignal(props.runtime.getSnapshot())
  onCleanup(props.runtime.subscribe(() => setSnapshot(props.runtime.getSnapshot())))
  return (
    <Show
      when={snapshot().activeApplicationId ? props.runtime.resolve(snapshot().activeApplicationId!) : null}
      fallback={props.recovery}
    >
      {contribution => {
        const Application = contribution().component
        return <Application />
      }}
    </Show>
  )
}
