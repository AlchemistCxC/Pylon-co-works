import { useSyncExternalStore, type ReactElement } from 'react'
import type { ApplicationRuntime } from './applicationRuntime'

interface ApplicationMountProps {
  runtime: ApplicationRuntime
  // React 19 严格 JSX：组件返回值须 ReactElement | null，recovery 收窄为元素实例
  recovery: ReactElement
}

export default function ApplicationMount({ runtime, recovery }: ApplicationMountProps): ReactElement | null {
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
  if (!snapshot.activeApplicationId) return recovery

  const contribution = runtime.resolve(snapshot.activeApplicationId)
  if (!contribution) return recovery

  const Application = contribution.component
  return <Application />
}
