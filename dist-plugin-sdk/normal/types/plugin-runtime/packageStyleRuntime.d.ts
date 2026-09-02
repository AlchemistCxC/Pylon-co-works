import type { PluginScope } from './pluginScope.js';
export interface PackageStyleDocument {
    readonly head: Pick<HTMLElement, 'appendChild'>;
    createElement(tagName: 'link'): HTMLLinkElement;
}
export type PackageStyleDocumentResolver = () => PackageStyleDocument | undefined;
export interface PackageStyleHandle {
    readonly count: number;
    commit(): void;
}
export interface PackageStyleLoadOptions {
    readonly pluginId: string;
    readonly runtimeInstanceId: string;
    readonly urls: readonly string[];
    readonly scope: PluginScope;
    readonly resolveDocument?: PackageStyleDocumentResolver;
}
/**
 * 把 manifest.web.styles 纳入 PluginScope：全部样式先以 `media=not all` 预加载，
 * 只有 module activation 成功后才 commit 生效；任一样式或 activation 失败时，
 * 已插入的 link 由 activation rollback 回收。
 */
export declare function loadPackageStyles(options: PackageStyleLoadOptions): Promise<PackageStyleHandle>;
