/**
 * Public, stable names for the host visual language. Values live in index.css.
 *
 * `VISUAL_SEMANTIC_ROLE_TOKENS` is the ABI for the twelve host palette roles.
 * Theme field metadata and the CSS snapshot consume this object directly so
 * there is no second palette/role registry.
 */
export declare const VISUAL_SEMANTIC_ROLE_TOKENS: Readonly<{
    readonly 'surface.canvas': "--surface-canvas";
    readonly 'surface.panel': "--surface-panel";
    readonly 'surface.raised': "--surface-raised";
    readonly 'content.text': "--content-text";
    readonly 'content.muted': "--content-muted";
    readonly 'stroke.default': "--stroke-default";
    readonly accent: "--accent";
    readonly 'state.success': "--state-success";
    readonly 'state.warning': "--state-warning";
    readonly 'state.danger': "--state-danger";
    readonly 'state.focusRing': "--state-focus-ring";
    readonly 'connector.default': "--connector-default";
}>;
export type VisualSemanticRole = keyof typeof VISUAL_SEMANTIC_ROLE_TOKENS;
export declare const VISUAL_SEMANTIC_TOKENS: Readonly<{
    surface: Readonly<{
        canvas: "--surface-canvas";
        panel: "--surface-panel";
        raised: "--surface-raised";
        overlay: "--surface-overlay";
        sunken: "--surface-sunken";
        glass: "--surface-glass";
    }>;
    content: Readonly<{
        text: "--content-text";
        muted: "--content-muted";
    }>;
    state: Readonly<{
        hover: "--state-hover-bg";
        selected: "--state-selected-bg";
        selectedStroke: "--state-selected-stroke";
        disabledOpacity: "--state-disabled-opacity";
        focusRing: "--state-focus-ring";
        success: "--state-success";
        warning: "--state-warning";
        danger: "--state-danger";
        dangerSurface: "--state-danger-surface";
        warningSurface: "--state-warning-surface";
        successSurface: "--state-success-surface";
    }>;
    stroke: Readonly<{
        subtle: "--stroke-subtle";
        default: "--stroke-default";
        strong: "--stroke-strong";
    }>;
    accent: "--accent";
    connector: Readonly<{
        default: "--connector-default";
    }>;
    shadow: Readonly<{
        soft: "--shadow-soft";
        raised: "--shadow-raised";
        float: "--shadow-float";
    }>;
    radius: Readonly<{
        none: "--ui-radius-none";
        xs: "--ui-radius-xs";
        sm: "--ui-radius-sm";
        md: "--ui-radius-md";
        lg: "--ui-radius-lg";
        pill: "--ui-radius-pill";
    }>;
    motion: Readonly<{
        fast: "--motion-fast";
        standard: "--motion-standard";
        slow: "--motion-slow";
        easing: "--ease-standard";
        emphasized: "--ease-emphasized";
    }>;
    type: Readonly<{
        interface: Readonly<{
            font: "--type-interface-font";
            xs: "--type-interface-xs";
            sm: "--type-interface-sm";
            md: "--type-interface-md";
            lg: "--type-interface-lg";
            lineHeight: "--type-interface-line-height";
        }>;
        content: Readonly<{
            font: "--type-content-font";
            xs: "--type-content-xs";
            sm: "--type-content-sm";
            md: "--type-content-md";
            lg: "--type-content-lg";
            lineHeight: "--type-content-line-height";
        }>;
        code: Readonly<{
            font: "--type-code-font";
            xs: "--type-code-xs";
            sm: "--type-code-sm";
            md: "--type-code-md";
            lg: "--type-code-lg";
            lineHeight: "--type-code-line-height";
        }>;
    }>;
}>;
export type VisualSemanticTokenGroup = keyof typeof VISUAL_SEMANTIC_TOKENS;
