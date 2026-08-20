import { useEffect, useRef, useState } from 'react'
import { loadSolidWorkbenchSmoke } from './loadSolidWorkbenchSmoke.ts'
import type {
  SolidWorkbenchSmokeInput,
  SolidWorkbenchSmokeLifecycle,
} from './solidWorkbenchSmokeContracts.ts'

interface Props extends SolidWorkbenchSmokeInput {
  onLifecycle?: (lifecycle: SolidWorkbenchSmokeLifecycle | null) => void
}

export default function SolidWorkbenchSmokeHost({ label, value, onLifecycle }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const lifecycleRef = useRef<SolidWorkbenchSmokeLifecycle | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false

    void loadSolidWorkbenchSmoke().then(({ mountSolidWorkbenchSmoke }) => {
      if (cancelled || !hostRef.current) return
      const lifecycle = mountSolidWorkbenchSmoke(hostRef.current, { label, value })
      lifecycleRef.current = lifecycle
      onLifecycle?.(lifecycle)
      setReady(true)
    })

    return () => {
      cancelled = true
      lifecycleRef.current?.destroy()
      lifecycleRef.current = null
      onLifecycle?.(null)
    }
    // Solid root 只 mount 一次；后续输入由独立 update effect 推送。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!ready) return
    lifecycleRef.current?.update({ label, value })
  }, [label, value, ready])

  return <div ref={hostRef} className="solid-workbench-smoke-host" data-ready={ready} />
}
