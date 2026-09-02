import { type SpinnerAssetId } from './spinnerAssets.js';
import { type SpinnerMotionKind } from './spinnerMotion.js';
export declare const DEFAULT_SPARKLES: string;
export type SpinnerFramePreset = SpinnerAssetId;
export declare function normalizeSpinnerFrames(value: string): string[];
/** 内置帧集解析（core.renderer.spinner 与无插件回退共用）。 */
export declare function resolveSpinnerFramesBuiltin(preset: SpinnerFramePreset, custom: string): string[];
/** legacy 查询面 facade：优先走已注册 provider（core 插件），未注册时回退 builtin。 */
export declare function resolveSpinnerFrames(preset: SpinnerFramePreset, custom: string): string[];
export type SpinnerMarkerMode = 'frame' | 'custom';
export declare function resolveSpinnerMarker(frames: string[], mode: SpinnerMarkerMode, value: string): string;
export declare function splitSpinnerFrames(value: string): string[];
export declare function frameAt(frames: string[], elapsedMs: number, intervalMs?: number, motion?: SpinnerMotionKind, direction?: 'forward' | 'reverse' | 'alternate'): string;
