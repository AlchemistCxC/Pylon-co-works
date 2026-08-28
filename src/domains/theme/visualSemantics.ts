/**
 * Public, stable names for the host visual language. Values live in index.css.
 *
 * `VISUAL_SEMANTIC_ROLE_TOKENS` is the ABI for the twelve host palette roles.
 * Theme field metadata and the CSS snapshot consume this object directly so
 * there is no second palette/role registry.
 */
export const VISUAL_SEMANTIC_ROLE_TOKENS = Object.freeze({
  'surface.canvas': '--surface-canvas',
  'surface.panel': '--surface-panel',
  'surface.raised': '--surface-raised',
  'content.text': '--content-text',
  'content.muted': '--content-muted',
  'stroke.default': '--stroke-default',
  accent: '--accent',
  'state.success': '--state-success',
  'state.warning': '--state-warning',
  'state.danger': '--state-danger',
  'state.focusRing': '--state-focus-ring',
  'connector.default': '--connector-default',
} as const)

export type VisualSemanticRole = keyof typeof VISUAL_SEMANTIC_ROLE_TOKENS

export const VISUAL_SEMANTIC_TOKENS = Object.freeze({
  surface: Object.freeze({
    canvas: VISUAL_SEMANTIC_ROLE_TOKENS['surface.canvas'],
    panel: VISUAL_SEMANTIC_ROLE_TOKENS['surface.panel'],
    raised: VISUAL_SEMANTIC_ROLE_TOKENS['surface.raised'],
    overlay: '--surface-overlay',
    sunken: '--surface-sunken',
    glass: '--surface-glass',
  }),
  content: Object.freeze({
    text: VISUAL_SEMANTIC_ROLE_TOKENS['content.text'],
    muted: VISUAL_SEMANTIC_ROLE_TOKENS['content.muted'],
  }),
  state: Object.freeze({
    hover: '--state-hover-bg',
    selected: '--state-selected-bg',
    selectedStroke: '--state-selected-stroke',
    disabledOpacity: '--state-disabled-opacity',
    focusRing: VISUAL_SEMANTIC_ROLE_TOKENS['state.focusRing'],
    success: VISUAL_SEMANTIC_ROLE_TOKENS['state.success'],
    warning: VISUAL_SEMANTIC_ROLE_TOKENS['state.warning'],
    danger: VISUAL_SEMANTIC_ROLE_TOKENS['state.danger'],
    dangerSurface: '--state-danger-surface',
    warningSurface: '--state-warning-surface',
    successSurface: '--state-success-surface',
  }),
  stroke: Object.freeze({ subtle: '--stroke-subtle', default: VISUAL_SEMANTIC_ROLE_TOKENS['stroke.default'], strong: '--stroke-strong' }),
  accent: VISUAL_SEMANTIC_ROLE_TOKENS.accent,
  connector: Object.freeze({ default: VISUAL_SEMANTIC_ROLE_TOKENS['connector.default'] }),
  shadow: Object.freeze({ soft: '--shadow-soft', raised: '--shadow-raised', float: '--shadow-float' }),
  radius: Object.freeze({ none: '--ui-radius-none', xs: '--ui-radius-xs', sm: '--ui-radius-sm', md: '--ui-radius-md', lg: '--ui-radius-lg', pill: '--ui-radius-pill' }),
  motion: Object.freeze({ fast: '--motion-fast', standard: '--motion-standard', slow: '--motion-slow', easing: '--ease-standard', emphasized: '--ease-emphasized' }),
  type: Object.freeze({
    interface: Object.freeze({ font: '--type-interface-font', xs: '--type-interface-xs', sm: '--type-interface-sm', md: '--type-interface-md', lg: '--type-interface-lg', lineHeight: '--type-interface-line-height' }),
    content: Object.freeze({ font: '--type-content-font', xs: '--type-content-xs', sm: '--type-content-sm', md: '--type-content-md', lg: '--type-content-lg', lineHeight: '--type-content-line-height' }),
    code: Object.freeze({ font: '--type-code-font', xs: '--type-code-xs', sm: '--type-code-sm', md: '--type-code-md', lg: '--type-code-lg', lineHeight: '--type-code-line-height' }),
  }),
})

export type VisualSemanticTokenGroup = keyof typeof VISUAL_SEMANTIC_TOKENS
