export declare function getGraphemeSegmenter(): Intl.Segmenter;
/** 按字素拆串；无 Intl.Segmenter 的环境回退为逐码点（与旧 spinner 实现语义一致） */
export declare function segmentGraphemes(value: string): string[];
/** 单个 grapheme 的显示宽度（0/1/2），按码点聚合；emoji 序列按宽 2 计 */
export declare function graphemeWidth(segment: string): number;
/** 字符串显示宽度（grapheme 安全，不拆 emoji/CJK 组合） */
export declare function stringWidth(text: string): number;
/** 按显示宽度截断（grapheme 边界），追加 … */
export declare function truncateToWidth(text: string, maxWidth: number): string;
