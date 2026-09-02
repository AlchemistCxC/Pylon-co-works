export type SpinnerMotionKind = 'cycle' | 'bounce' | 'ping-pong' | 'pulse' | 'static';
export interface FrameIndexOptions {
    frameCount: number;
    elapsedMs: number;
    intervalMs: number;
    motion: SpinnerMotionKind;
    direction?: 'forward' | 'reverse' | 'alternate';
}
export declare function resolveFrameIndex({ frameCount, elapsedMs, intervalMs, motion, direction }: FrameIndexOptions): number;
