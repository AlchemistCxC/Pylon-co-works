/**
 * sessionUiState — 会话级 UI 状态注册表。
 *
 * 草稿/搜索等 UI 状态按 sessionId 键保存：切会话不串（A 草稿不显示在 B）、
 * 不丢（切回 A 恢复草稿）。多会话基建的一部分（配合 per-source 数据层）。
 * 模块级单例；会话关闭时调 clearSessionUiState(id) 清理，防注册表残留。
 */
import { type Dispatch, type SetStateAction } from 'react';
export declare function sessionUiStateGet<T>(sessionId: string, key: string): T | undefined;
export declare function sessionUiStateSet<T>(sessionId: string, key: string, value: T): void;
export declare function clearSessionUiState(sessionId: string): void;
/** 清空全部会话 UI 状态（测试夹具 resetStores 用；生产代码不调用） */
export declare function clearAllSessionUiState(): void;
/**
 * 按会话作用域的 UI 状态。sessionId 变化时从注册表恢复（无存档用 initial）。
 * 注意：initial 只在首次/无存档时生效，后续被注册表覆盖；不必担心 initial
 * 引用变化（用 ref 捕获，不参与 effect 依赖，避免对象字面量触发反复恢复）。
 */
export declare function useSessionUiState<T>(sessionId: string | null, key: string, initial: T): [T, Dispatch<SetStateAction<T>>];
