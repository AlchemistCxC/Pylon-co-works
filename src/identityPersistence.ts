/**
 * identityPersistence — identity 域的持久化 boundary（#228 批次D 自 identityStore 切出）。
 *
 * 承载：localStorage cache meta（I14 读回 revision baseline）、mutation 域守卫
 * （degraded-readonly 阻断）、CR-001 merge-unresolved 写盘、persistFlag。
 * 纯 helper 模块：不 import store（类型经 type-only 反向引用，编译期擦除，无运行时环）。
 * store 本体（状态与变更逻辑）仍在 identityStore；后端 SQLite 写穿见 identityBackendSync。
 */
import { IS_TAURI, isBrowserMockRuntime } from './infrastructure/tauri/env.ts'
import { persistSessionsWithUnresolved } from './sessionPersistence.ts'
import type { Session, SessionHydrationState, IdentityPersistenceState, Turn } from './identityStore.ts'

export const hasBackend = () => IS_TAURI && !isBrowserMockRuntime()

export const IDENTITY_CACHE_META_KEY = 'pylon-identity-cache-meta:v1'

interface IdentityCacheMeta {
  version: 1
  profiles: { revision: number; state: 'clean' | 'pending' | 'stale' }
  sessions: { revision: number; state: 'clean' | 'pending' | 'stale' }
}

export function updateIdentityCacheMeta(
  domain: keyof IdentityPersistenceState,
  state: IdentityCacheMeta['profiles']['state'],
  revision?: number,
): void {
  try {
    const parsed = JSON.parse(localStorage.getItem(IDENTITY_CACHE_META_KEY) ?? 'null') as Partial<IdentityCacheMeta> | null
    const fallback = { revision: 0, state: 'stale' as const }
    const current: IdentityCacheMeta = {
      version: 1,
      profiles: parsed?.profiles?.revision !== undefined ? parsed.profiles as IdentityCacheMeta['profiles'] : fallback,
      sessions: parsed?.sessions?.revision !== undefined ? parsed.sessions as IdentityCacheMeta['sessions'] : fallback,
    }
    current[domain] = { revision: revision ?? current[domain].revision, state }
    localStorage.setItem(IDENTITY_CACHE_META_KEY, JSON.stringify(current))
  } catch {
    // Cache metadata 失败不能改变 SQLite authority 或让业务 mutation 抛错。
  }
}

export function canMutateIdentityDomain(
  persistence: IdentityPersistenceState,
  ...domains: Array<keyof IdentityPersistenceState>
): boolean {
  return !hasBackend() || domains.every(domain => persistence[domain] !== 'degraded-readonly')
}

/**
 * CR-001：mutation 持久化必须保留 unresolved 现场——state.sessions 只含已解析子集，
 * 直接 persistSessions 会用子集覆盖存储、永久丢失未决 legacy 会话。写盘前把
 * sessionHydration.unresolved（不补 agentId）并入 envelope，下次 load 重新推断。
 */
export function persistMergingUnresolved(sessions: Session[], turns: Turn[], hydration: SessionHydrationState | null): boolean {
  const unresolved = hydration?.kind === 'needs-owner-resolution' ? hydration.unresolved : []
  return persistSessionsWithUnresolved(localStorage, sessions, unresolved, turns)
}

/** 报告 1C L1：写盘结果 → 配置未保存状态（失败设提示；成功且旧错则清空） */
export function persistFlag(success: boolean, prevError: string | null): string | null {
  if (!success) return '配置未能保存到本地存储'
  return prevError ? null : prevError
}
