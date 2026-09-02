/** 产品查询门面；数据唯一来自统一 Renderer Registry。 */
import type { AnsiProvider, CodeHighlightProvider, FooterProvider, PlanProvider, SpinnerProvider } from '../../contracts/rendererContentPoints.js';
export declare function listCodeHighlightProviders(): CodeHighlightProvider[];
export declare function resolveCodeHighlightProvider(language?: string, code?: string): CodeHighlightProvider | undefined;
export declare function listAnsiProviders(): AnsiProvider[];
export declare function resolveAnsiProvider(text?: string): AnsiProvider | undefined;
export declare function listSpinnerProviders(): SpinnerProvider[];
export declare function resolveSpinnerProvider(input?: unknown): SpinnerProvider | undefined;
export declare function listPlanProviders(): PlanProvider[];
export declare function listFooterProviders(): FooterProvider[];
