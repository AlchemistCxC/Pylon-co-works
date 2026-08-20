/** Public, stable names for the host visual language. Values live in index.css. */
export const VISUAL_SEMANTIC_TOKENS = Object.freeze({
  surface: Object.freeze({
    canvas: '--surface-canvas',
    panel: '--surface-panel',
    raised: '--surface-raised',
    overlay: '--surface-overlay',
    sunken: '--surface-sunken',
    glass: '--surface-glass',
  }),
  state: Object.freeze({
    hover: '--state-hover-bg',
    selected: '--state-selected-bg',
    selectedStroke: '--state-selected-stroke',
    focusRing: '--state-focus-ring',
    danger: '--state-danger',
    dangerSurface: '--state-danger-surface',
    warningSurface: '--state-warning-surface',
    successSurface: '--state-success-surface',
  }),
  stroke: Object.freeze({ subtle: '--stroke-subtle', default: '--stroke-default', strong: '--stroke-strong' }),
  shadow: Object.freeze({ soft: '--shadow-soft', raised: '--shadow-raised', float: '--shadow-float' }),
  radius: Object.freeze({ xs: '--ui-radius-xs', sm: '--ui-radius-sm', md: '--ui-radius-md', lg: '--ui-radius-lg', pill: '--ui-radius-pill' }),
  motion: Object.freeze({ fast: '--motion-fast', standard: '--motion-standard', slow: '--motion-slow', easing: '--ease-standard', emphasized: '--ease-emphasized' }),
})

export type VisualSemanticTokenGroup = keyof typeof VISUAL_SEMANTIC_TOKENS

