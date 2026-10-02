/** @jsxImportSource solid-js */
import { createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import { loadSolidWorkbenchSmoke } from './loadSolidWorkbenchSmoke.ts'
import type {
  SolidWorkbenchSmokeInput,
  SolidWorkbenchSmokeLifecycle,
} from './solidWorkbenchSmokeContracts.ts'

export interface SolidWorkbenchSmokeHostProps extends SolidWorkbenchSmokeInput {
  onLifecycle?: (lifecycle: SolidWorkbenchSmokeLifecycle | null) => void
}

/**
 * Solid Workbench smoke 的页面宿主（#515 Solid 化；原 React 宿主已退役）。
 *
 * Solid root 只 mount 一次（动态 import 落地后）；后续输入由独立 effect 推入
 * 同一 root（lifecycle.update）。卸载时 destroy 回收，onLifecycle 对称通知 null。
 */
export default function SolidWorkbenchSmokeHost(props: SolidWorkbenchSmokeHostProps) {
  let host!: HTMLDivElement
  let lifecycle: SolidWorkbenchSmokeLifecycle | null = null
  const [ready, setReady] = createSignal(false)

  onMount(() => {
    let cancelled = false
    void loadSolidWorkbenchSmoke().then(({ mountSolidWorkbenchSmoke }) => {
      if (cancelled) return
      lifecycle = mountSolidWorkbenchSmoke(host, { label: props.label, value: props.value })
      props.onLifecycle?.(lifecycle)
      setReady(true)
    })
    onCleanup(() => {
      cancelled = true
      lifecycle?.destroy()
      lifecycle = null
      props.onLifecycle?.(null)
    })
  })

  createEffect(() => {
    const input = { label: props.label, value: props.value }
    if (ready()) lifecycle?.update(input)
  })

  return <div ref={host} class="solid-workbench-smoke-host" data-ready={ready() ? 'true' : 'false'} />
}
