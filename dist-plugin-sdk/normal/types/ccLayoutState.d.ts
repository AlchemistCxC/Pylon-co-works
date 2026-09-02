import { type CcWidgetId } from './domains/cc/widgetDefinitions.js';
export type { CcWidgetId } from './domains/cc/widgetDefinitions.js';
export type CcSlot = 'input' | 'status-primary' | 'status-secondary' | 'actions';
export interface CcWidgetPlacement {
    slot: CcSlot;
    order: number;
    offsetX: number;
    offsetY: number;
}
export interface CcLayoutV3 {
    version: number;
    placements: Record<CcWidgetId, CcWidgetPlacement>;
}
export declare const CC_LAYOUT_SCHEMA_VERSION = 7;
export declare const DEFAULT_CC_LAYOUT: CcLayoutV3;
export declare function cloneCcLayout(layout: CcLayoutV3): CcLayoutV3;
export declare function normalizeCcLayout(layout: Partial<CcLayoutV3> | null | undefined): CcLayoutV3;
export declare function updateCcPlacementState(layout: CcLayoutV3, id: string, partial: Partial<CcWidgetPlacement>): CcLayoutV3;
export declare function setCcHiddenState(hiddenIds: string[], id: string, hidden: boolean): string[];
export declare function setCcScaleState(scales: Record<string, number>, id: string, scale: number): Record<string, number>;
