export type CcInputMode = 'cli' | 'default' | string;
export type CcFooterLayout = 'free' | 'peri' | string;
export type CcHintMode = 'hidden' | 'compact' | 'full' | string;
export type CcOverflowMode = 'fixed-scroll' | 'grow' | 'overlay' | string;
export interface CcMinHeightOptions {
    inputMode: CcInputMode;
    footerLayout: CcFooterLayout;
    hintMode: CcHintMode;
    visibleStatusWidgets: number;
    cliOverflowMode: CcOverflowMode;
}
export declare function resolveVisibleStatusWidgetCount({ hiddenIds, inputMode, ccStyle, submitButtonMode, presentationProfileId, }: {
    hiddenIds: readonly string[];
    inputMode: CcInputMode;
    ccStyle: string;
    submitButtonMode: string;
    presentationProfileId?: string;
}): number;
/**
 * 计算中控区能够容纳当前结构的最小高度。
 * 这是布局约束真值；CSS、Settings 和 store action 都应消费同一结果。
 */
export declare function resolveCcMinHeight(options: CcMinHeightOptions): number;
export declare function clampCcHeight(height: number, options: CcMinHeightOptions): number;
