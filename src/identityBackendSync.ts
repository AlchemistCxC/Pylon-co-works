/**
 * identityBackendSync — identity 域的后端（Tauri SQLite user store）同步 boundary
 * （#228 批次D 自 identityStore 切出）。
 *
 * 承载：composition root（repository 选择）、I14-W5 mutation 写穿、flush/refresh。
 * 与 store 的关系经 IdentityBackendSyncHost 注入（getState/setState accessor），
 * 本模块不 import store 运行时绑定（类型经 type-only 反向引用，编译期擦除）——
 * 避免 identityStore ↔ 本模块的运行时循环依赖。localStorage 持久化 helper 见
 * identityPersistence；store 本体仍在 identityStore。
 */
import { resolveRuntimeErrors, reportRuntimeError } from './runtimeError.ts'
import { selectUserDataRepository, type UserDataRepository } from './userDataRepository.ts'
import { PROFILE_ENVELOPE_VERSION } from './profilePersistence.ts'
import { SESSION_SCHEMA_VERSION } from './sessionPersistence.ts'
import { updateIdentityCacheMeta } from './identityPersistence.ts'
import type { IdentityPersistenceState, Profile, Session, SessionHydrationState, Turn } from './identityStore.ts'

// ── I14-W5：后端 user store 写穿（Tauri 模式） ──
// composition root 选择：Tauri 走后端 versioned store；browser 模式 null（不经本仓库）。
export const userDataRepository: UserDataRepository | null = selectUserDataRepository()

/**
 * 等待全部身份写穿链落定（关闭前 flush / 测试收敛）；browser 模式为 no-op。
 * hydrateFromLocal 等路径的写穿是 fire-and-forget，调用方需要确定性落库时显式 flush。
 */
export async function flushIdentityBackend(): Promise<void> {
  await userDataRepository?.flush()
}

/** 删除会话等外部后端事务完成后，刷新 sessions revision baseline。 */
export async function refreshSessionsBackend(): Promise<void> {
  await userDataRepository?.load('sessions')
}

/** syncIdentityToBackend 读取并写回的 store 状态切片。 */
export interface IdentityBackendSyncSnapshot {
  profiles: Profile[]
  activeProfileId: string
  sessions: Session[]
  turns: Turn[]
  sessionHydration: SessionHydrationState | null
  identityPersistence: IdentityPersistenceState
  lastPersistError: string | null
}

/** 局部写回：partial 对象或（读当前状态的）updater，语义同 zustand setState。 */
export type IdentityBackendSyncPatch =
  | Partial<IdentityBackendSyncSnapshot>
  | ((current: IdentityBackendSyncSnapshot) => Partial<IdentityBackendSyncSnapshot>)

/** store 注入的读写通道（由 identityStore 以 getState/setState accessor 装配）。 */
export interface IdentityBackendSyncHost {
  getState: () => IdentityBackendSyncSnapshot
  setState: (patch: IdentityBackendSyncPatch) => void
}

/**
 * I14-W5：把当前 identity 状态（profiles/activeProfileId/sessions + unresolved）写穿到
 * 后端 versioned user store。经 host.getState() 读最新状态（调用方在 set() 应用后经
 * queueMicrotask 触发）；browser 模式直接跳过（localStorage 仍是主存储，W6 再接读回）。
 * 后端失败可见上报（reportRuntimeError → ErrorCenter），localStorage 写盘不受影响。
 */
export function createIdentityBackendSync(host: IdentityBackendSyncHost): (domains?: Array<keyof IdentityPersistenceState>) => void {
  const syncIdentityToBackend = (
    domains: Array<keyof IdentityPersistenceState> = ['profiles', 'sessions'],
  ): void => {
    if (!userDataRepository) return
    const state = host.getState()
    const unresolved = state.sessionHydration?.kind === 'needs-owner-resolution' ? state.sessionHydration.unresolved : []
    const handleError = (domain: 'profiles' | 'sessions', error: unknown): void => {
      updateIdentityCacheMeta(domain, 'stale')
      host.setState(current => ({
        lastPersistError: 'SQLite 用户数据同步失败；已切换为只读，请重试恢复',
        identityPersistence: { ...current.identityPersistence, [domain]: 'degraded-readonly' },
      }))
      reportRuntimeError(`同步用户数据到后端失败（${domain}）`, error, undefined, {
        key: `identity:sync:${domain}`, scope: { kind: 'app', id: 'identity' }, source: 'identity.sync',
        recovery: { kind: 'open-runtime-log' },
      })
    }
    if (domains.includes('profiles') && state.identityPersistence.profiles !== 'degraded-readonly') {
      updateIdentityCacheMeta('profiles', 'pending')
      void userDataRepository.save('profiles', {
        version: PROFILE_ENVELOPE_VERSION,
        profiles: state.profiles,
        activeProfileId: state.activeProfileId,
      }).then((revision) => {
        updateIdentityCacheMeta('profiles', 'clean', revision)
        host.setState(current => ({
          lastPersistError: current.identityPersistence.sessions === 'degraded-readonly' ? current.lastPersistError : null,
          identityPersistence: { ...current.identityPersistence, profiles: 'ready' },
        }))
        resolveRuntimeErrors({ key: 'identity:sync:profiles' })
      }).catch((error) => {
        handleError('profiles', error)
      })
    }
    if (domains.includes('sessions') && state.identityPersistence.sessions !== 'degraded-readonly') {
      updateIdentityCacheMeta('sessions', 'pending')
      void userDataRepository.save('sessions', {
        version: SESSION_SCHEMA_VERSION,
        sessions: [...state.sessions, ...unresolved],
        turns: state.turns,
      }).then((revision) => {
        updateIdentityCacheMeta('sessions', 'clean', revision)
        host.setState(current => ({
          lastPersistError: current.identityPersistence.profiles === 'degraded-readonly' ? current.lastPersistError : null,
          identityPersistence: { ...current.identityPersistence, sessions: 'ready' },
        }))
        resolveRuntimeErrors({ key: 'identity:sync:sessions' })
      }).catch((error) => {
        handleError('sessions', error)
      })
    }
  }
  return syncIdentityToBackend
}
