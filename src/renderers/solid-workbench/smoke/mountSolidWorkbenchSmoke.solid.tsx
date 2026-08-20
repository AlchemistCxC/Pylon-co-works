import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import type { SolidWorkbenchSmokeInput, SolidWorkbenchSmokeLifecycle } from './solidWorkbenchSmokeContracts.ts'
import './solidWorkbenchSmoke.css'

function SolidWorkbenchSmoke(props: { input: () => SolidWorkbenchSmokeInput }) {
  return (
    <section class="solid-workbench-smoke" data-renderer="solid" aria-label="Solid Workbench smoke">
      <span class="solid-workbench-smoke__label">{props.input().label}</span>
      <output class="solid-workbench-smoke__value">{props.input().value}</output>
    </section>
  )
}

export function mountSolidWorkbenchSmoke(
  host: HTMLElement,
  initialInput: SolidWorkbenchSmokeInput,
): SolidWorkbenchSmokeLifecycle {
  let destroyed = false
  const [input, setInput] = createSignal({ ...initialInput })
  const dispose = render(() => <SolidWorkbenchSmoke input={input} />, host)

  return {
    update(nextInput) {
      if (destroyed) return
      setInput({ ...nextInput })
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      dispose()
      host.replaceChildren()
    },
  }
}
