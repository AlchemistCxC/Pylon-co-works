import { createEffect, createSignal, createUniqueId, type Accessor, type Setter } from 'solid-js'

export interface CollapsiblePresenterOptions {
  /** Initial state and, when requested, the presentation setting to follow. */
  readonly defaultOpen: Accessor<boolean>
  /** Reset user state only when this semantic identity changes. */
  readonly resetKey?: Accessor<unknown>
  /** Presentation previews may opt into resetting when their default changes. */
  readonly resetOnDefaultChange?: boolean
  readonly bodyId?: string | Accessor<string>
  readonly idPrefix?: string
}

export interface CollapsiblePresenter {
  readonly open: Accessor<boolean>
  readonly setOpen: Setter<boolean>
  readonly bodyId: string
  readonly toggle: () => void
}

/**
 * Internal collapse-state seam shared by Solid presenters.
 *
 * Ordinary reactive updates never reset user intent. A caller must explicitly
 * name the semantic identity or opt into presentation-default synchronisation.
 */
export function createCollapsiblePresenter(options: CollapsiblePresenterOptions): CollapsiblePresenter {
  let previousDefault = options.defaultOpen()
  let previousResetKey = options.resetKey?.()
  const [open, setOpen] = createSignal(previousDefault)
  const generatedBodyId = `${options.idPrefix ?? 'solid-collapse'}-${createUniqueId()}`

  createEffect(() => {
    const nextDefault = options.defaultOpen()
    const nextResetKey = options.resetKey?.()
    const identityChanged = options.resetKey !== undefined && !Object.is(nextResetKey, previousResetKey)
    const defaultChanged = options.resetOnDefaultChange === true && nextDefault !== previousDefault
    if (identityChanged || defaultChanged) setOpen(nextDefault)
    previousDefault = nextDefault
    previousResetKey = nextResetKey
  })

  return {
    open,
    setOpen,
    get bodyId() {
      return typeof options.bodyId === 'function' ? options.bodyId() : options.bodyId ?? generatedBodyId
    },
    toggle: () => setOpen(value => !value),
  }
}
