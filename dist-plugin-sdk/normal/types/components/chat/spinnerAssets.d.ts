import type { SpinnerMotionKind } from './spinnerMotion.js';
export type SpinnerAssetId = 'sparkles' | 'ascii-line' | 'braille' | 'dots' | 'orbit' | 'clock' | 'wave' | 'blocks' | 'scan' | 'cc' | 'custom';
export interface SpinnerAssetPreset {
    id: SpinnerAssetId;
    label: string;
    frames: string;
    motion: SpinnerMotionKind;
    defaultIntervalMs: number;
    direction?: 'forward' | 'reverse' | 'alternate';
}
export interface SpinnerVerbPreset {
    id: 'zh' | 'en' | 'analysis' | 'engineering' | 'cc' | 'custom';
    label: string;
    verbs: readonly string[];
}
export declare const SPINNER_ASSET_PRESETS: readonly SpinnerAssetPreset[];
export declare const SPINNER_VERB_PRESETS: readonly SpinnerVerbPreset[];
export declare function getSpinnerAssetPreset(id: string): SpinnerAssetPreset;
export declare function getSpinnerVerbPreset(id: string): SpinnerVerbPreset;
