import { type CcLayoutV3 } from '../../ccLayoutState.js';
import { getSpinnerAssetPreset, type SpinnerAssetId } from '../../components/chat/spinnerAssets.js';
import { type SpinnerMarkerMode } from '../../components/chat/spinnerFrames.js';
import type { ThemeSettings } from '../../store.js';
import type { CcWidgetPlacement } from '../../ccLayoutState.js';
import type { CcEditablePropertyKey, CcPropertyCommand } from '../cc/widgetDefinitions.js';
export interface SpinnerAppearanceSnapshot {
    framePreset: SpinnerAssetId;
    frames: readonly string[];
    motion: ReturnType<typeof getSpinnerAssetPreset>['motion'];
    direction?: 'forward' | 'reverse' | 'alternate';
    intervalMs: number;
    verbSet: string;
    verbs: readonly string[];
    color: string;
    stalledColor: string;
    size: number;
    doneMarker: string;
    cancelledMarker: string;
    errorMarker: string;
    doneMarkerMode: SpinnerMarkerMode;
    cancelledMarkerMode: SpinnerMarkerMode;
    errorMarkerMode: SpinnerMarkerMode;
}
export interface WorkbenchAppearanceSnapshot {
    revision: number;
    uiScheme: 'light' | 'dark';
    msgStyle: string;
    messageLayout: 'classic' | 'claude' | 'bubble';
    userName: string;
    userPrefix: string;
    userColor: string;
    assistantDot: boolean;
    assistantDotGlyph: string;
    assistantDotColor: string;
    assistantDotImage: string;
    toolIndicator: string;
    toolIndicatorRun: string;
    toolIndicatorOk: string;
    toolIndicatorErr: string;
    toolIndicatorGlow: number;
    toolIndicatorGlowColor: string;
    toolConnectorMode: string;
    toolConnectorColor: string;
    toolConnectorStyle: string;
    toolConnectorWidth: number;
    toolConnectorOpacity: number;
    inputMode: string;
    inputVariant: string;
    inputShowPlaceholder: boolean;
    inputShowHistoryHint: boolean;
    inputSubmitButtonMode: string;
    modelVariant: string;
    modeVariant: string;
    sendVariant: string;
    attachVariant: string;
    cliHintMode: string;
    footerLayout: string;
    cliOverflowMode: string;
    ccVariant: string;
    ccStyle: string;
    ccHeight: number;
    ccBgHeight: number;
    ccLayout: CcLayoutV3;
    ccHidden: readonly string[];
    ccScale: Readonly<Record<string, number>>;
    ccEditMode: boolean;
    ccProperties: Readonly<Pick<ThemeSettings, CcEditablePropertyKey>>;
    showPet: boolean;
    spinner: SpinnerAppearanceSnapshot;
}
export type AppearanceCommand = {
    type: 'set-cc-edit-mode';
    enabled: boolean;
} | {
    type: 'set-cc-hidden';
    id: string;
    hidden: boolean;
} | {
    type: 'set-cc-scale';
    id: string;
    scale: number;
} | {
    type: 'set-cc-height';
    height: number;
} | {
    type: 'update-cc-placement';
    id: string;
    placement: Partial<CcWidgetPlacement>;
} | CcPropertyCommand | {
    type: 'reset-cc-layout';
};
export interface WorkbenchAppearanceStore {
    getSnapshot(): WorkbenchAppearanceSnapshot;
    subscribe(listener: () => void): () => void;
    dispatch(command: AppearanceCommand): void;
    destroy(): void;
}
export declare function selectWorkbenchAppearance(theme: Readonly<ThemeSettings>, revision: number): WorkbenchAppearanceSnapshot;
export declare function areWorkbenchAppearancesEqual(left: WorkbenchAppearanceSnapshot, right: WorkbenchAppearanceSnapshot): boolean;
