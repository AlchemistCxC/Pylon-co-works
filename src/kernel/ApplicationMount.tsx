import { useSyncExternalStore, type ReactNode } from 'react'
import type { ApplicationRuntime } from './applicationRuntime'

interface ApplicationMountProps {
  runtime: ApplicationRuntime
  recovery: ReactNode
}

export default function ApplicationMount({ runtime, recovery }: ApplicationMountProps) {
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
  if (!snapshot.activeApplicationId) return recovery

  const contribution = runtime.resolve(snapshot.activeApplicationId)
  if (!contribution) return recovery

  const Application = contribution.component
  return <Application />
}
