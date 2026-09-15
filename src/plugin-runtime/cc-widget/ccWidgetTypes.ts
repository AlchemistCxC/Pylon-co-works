/** Framework-neutral property metadata; product layers may refine this shape. */
export type CcWidgetPropertyField = Readonly<Record<string, unknown>>

export interface CcWidgetPlacement {
  readonly slot: 'input' | 'status-primary' | 'status-secondary' | 'actions'
  readonly order: number
  readonly offsetX: number
  readonly offsetY: number
}

export type CcWidgetRenderSpec =
  | { readonly kind: 'host-renderer'; readonly rendererKey: string }
  | { readonly kind: 'isolated-surface'; readonly surfaceId: string }

export interface CcWidgetContribution {
  readonly id: string
  readonly label: string
  readonly category?: string
  readonly render?: CcWidgetRenderSpec
  readonly propertyFields?: readonly CcWidgetPropertyField[]
  readonly defaultPlacement?: CcWidgetPlacement
}

export interface ResolvedCcWidget extends CcWidgetContribution {
  readonly ownerPluginId: string
  readonly ownerRuntimeInstanceId: string
  readonly contributionId: string
}
