import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  getBuiltinPluginIds,
  getBuiltinPluginCriticality,
  getPackageInstallationService,
  getPluginRuntime,
} from '../../plugin-runtime/pluginCompositionRoot.ts'
import { PYLON_PLUGIN_API_VERSION } from '../../plugin-runtime/packageManifest.ts'
import type { PackageInstallationService } from '../../plugin-runtime/packageInstallationService.ts'
import type { PluginDeactivateResult } from '../../plugin-runtime/pluginInstance.ts'
import type { InstalledPluginPackage } from '../../infrastructure/plugins/pluginPackageClient.ts'
import { IS_TAURI } from '../../infrastructure/tauri/env.ts'
import { kernelBootstrap } from '../../kernel/kernelBootstrapServices.ts'
import type { KernelBootstrap } from '../../kernel/kernelBootstrap.ts'
import { reportRuntimeError, resolveRuntimeErrors } from '../../runtimeError.ts'
import PluginCapabilityConsentCard from './PluginCapabilityConsentCard.tsx'
import { BUILTIN_PYLON_PLUGIN_MANAGER_ID } from '../../plugins/product/productPluginIds.ts'

const LOG_LIMIT = 12

const BUILTIN_PLUGIN_NAMES: Record<string, string> = {
  'builtin.pylon-agent-adapters': 'Agent 适配器',
  'builtin.pylon-renderers': '聊天与内容渲染器',
  'builtin.pylon-shell': '应用外壳',
  'builtin.pylon-tools': '工具字典',
  'builtin.pylon-workspace': '工作区与 Sheet',
  'builtin.pylon-plugin-manager': '插件管理器（增强）',
  'builtin.skin': '主题与皮肤',
}

export interface PluginManagerProps {
  service?: PackageInstallationService
  pickDirectory?: () => Promise<string | null>
  /** P53 D6：zip / URL 安装源选择器（默认 tauri dialog / prompt）。 */
  pickZipFile?: () => Promise<string | null>
  promptUrl?: () => Promise<string | null>
  bootstrap?: KernelBootstrap
}

async function pickPluginDirectory(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({ directory: true, multiple: false, title: '选择 api=1.0 插件包' })
  return typeof selected === 'string' ? selected : null
}

/** P53 D6：选择本机 zip 安装包。 */
async function pickPluginZip(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    multiple: false,
    title: '选择插件 zip 包',
    filters: [{ name: '插件包', extensions: ['zip'] }],
  })
  return typeof selected === 'string' ? selected : null
}

/** P53 D6：输入 https 安装源 URL。 */
async function promptPluginUrl(): Promise<string | null> {
  const input = window.prompt('输入插件包 https URL（仅支持 https）')
  const trimmed = input?.trim()
  return trimmed ? trimmed : null
}

function cleanupResultMessage(result: PluginDeactivateResult): string {
  const errors = [result.deactivateError, ...result.scope.errors]
    .filter((error): error is NonNullable<typeof error> => error !== undefined)
    .map(error => `${error.resourceId}: ${error.message}`)
  return errors.length > 0 ? errors.join('；') : `${result.scope.remaining} 个资源仍待清理`
}

export default function PluginManager({
  service: serviceProp,
  pickDirectory = pickPluginDirectory,
  pickZipFile = pickPluginZip,
  promptUrl = promptPluginUrl,
  bootstrap = kernelBootstrap,
}: PluginManagerProps = {}) {
  const runtime = getPluginRuntime()
  const service = serviceProp ?? getPackageInstallationService()
  const browserMockAvailable = import.meta.env.DEV
    && typeof window !== 'undefined'
    && '__TAURI_INTERNALS__' in window
  const nativePackagesAvailable = serviceProp !== undefined || IS_TAURI || browserMockAvailable
  const subscribe = useCallback((listener: () => void) => runtime.subscribe(listener), [runtime])
  const snapshot = useSyncExternalStore(subscribe, () => runtime.snapshot(), () => runtime.snapshot())
  const bootstrapSnapshot = useSyncExternalStore(
    bootstrap.subscribe,
    bootstrap.getSnapshot,
    bootstrap.getSnapshot,
  )
  const subscribeContracts = useCallback(
    (listener: () => void) => service.subscribeContracts(listener),
    [service],
  )
  const contractSnapshot = useSyncExternalStore(
    subscribeContracts,
    () => service.getContractSnapshot(),
    () => service.getContractSnapshot(),
  )
  const [installed, setInstalled] = useState<InstalledPluginPackage[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])
  const reportedBootstrapKeysRef = useRef<Map<string, string>>(new Map())

  const appendLog = useCallback((line: string) => {
    setLog(previous => [...previous.slice(-(LOG_LIMIT - 1)), line])
  }, [])

  const refresh = useCallback(async () => {
    if (!nativePackagesAvailable) {
      setInstalled([])
      return
    }
    setInstalled(await service.list())
    resolveRuntimeErrors({ key: 'plugin-manager:list' })
  }, [nativePackagesAvailable, service])

  useEffect(() => {
    if (!nativePackagesAvailable) return
    void refresh()
      .catch(error => {
        appendLog(`读取 API 1.0 插件包失败：${error instanceof Error ? error.message : String(error)}`)
        reportRuntimeError('读取 API 1.0 插件包', error, undefined, {
          key: 'plugin-manager:list', scope: { kind: 'app', id: 'settings-plugin-manager' }, source: 'settings.plugin-manager',
          recovery: { kind: 'open-runtime-log' },
        })
      })
  }, [appendLog, nativePackagesAvailable, refresh, service])

  // Plugin bootstrap failures are recoverable runtime facts. Keep the retry
  // affordance in this panel, but publish one scoped notification so the
  // ordinary error presentation still lives in the central tray.
  useEffect(() => {
    const failures = bootstrapSnapshot.kind === 'degraded' ? bootstrapSnapshot.failures : []
    const nextKeys = new Map<string, string>()
    for (const failure of failures) {
      const key = `plugin-bootstrap:${failure.pluginId}:${failure.stage}`
      nextKeys.set(key, failure.message)
      if (reportedBootstrapKeysRef.current.get(key) === failure.message) continue
      reportRuntimeError('启动插件', new Error(failure.message), undefined, {
        key,
        scope: { kind: 'operation', id: `plugin:${failure.pluginId}` },
        source: 'kernel.plugin-bootstrap',
        metadata: { pluginId: failure.pluginId, stage: failure.stage, code: failure.code },
        recovery: { kind: 'open-runtime-log', suiteId: failure.pluginId },
        recoveryAction: failure.retryable
          ? { label: `重试 ${failure.pluginId}`, run: () => bootstrap.retryPlugin(failure.pluginId) }
          : undefined,
      })
    }
    for (const key of reportedBootstrapKeysRef.current.keys()) {
      if (!nextKeys.has(key)) resolveRuntimeErrors({ key })
    }
    reportedBootstrapKeysRef.current = nextKeys
  }, [bootstrap, bootstrapSnapshot])

  const run = async (label: string, task: () => Promise<{ ok: boolean; message?: string }>) => {
    if (busy) return
    setBusy(label)
    try {
      const result = await task()
      appendLog(result.ok ? `${label}成功` : `${label}失败：${result.message ?? '未知错误'}`)
      if (result.ok) {
        resolveRuntimeErrors({ key: `plugin-manager:${label}` })
      } else {
        reportRuntimeError(label, new Error(result.message ?? '未知错误'), undefined, {
          key: `plugin-manager:${label}`, scope: { kind: 'app', id: 'settings-plugin-manager' }, source: 'settings.plugin-manager',
          recovery: { kind: 'open-runtime-log' },
        })
      }
      await refresh()
    } catch (error) {
      appendLog(`${label}失败：${error instanceof Error ? error.message : String(error)}`)
      reportRuntimeError(label, error, undefined, {
        key: `plugin-manager:${label}`, scope: { kind: 'app', id: 'settings-plugin-manager' }, source: 'settings.plugin-manager',
        recovery: { kind: 'open-runtime-log' },
      })
    } finally {
      setBusy(null)
    }
  }

  const installOrUpdate = async () => {
    if (!nativePackagesAvailable) return
    const sourcePath = await pickDirectory()
    if (!sourcePath) return
    await run('安装/更新', () => service.installOrUpdate(sourcePath))
  }

  // P53 D6：zip / URL 安装源（三选入口；仅 https 且复用同一事务）
  const installFromZip = async () => {
    if (!nativePackagesAvailable) return
    const zipPath = await pickZipFile()
    if (!zipPath) return
    await run('从 zip 安装', () => service.installOrUpdateFromZip(zipPath))
  }

  const installFromUrl = async () => {
    if (!nativePackagesAvailable) return
    const url = await promptUrl()
    if (!url) return
    await run('从 URL 安装', () => service.installOrUpdateFromUrl(url))
  }

  const activeById = useMemo(
    () => new Map(snapshot.active.map(identity => [identity.pluginId, identity])),
    [snapshot],
  )
  const cleanupFailuresById = useMemo(() => {
    const failures = new Map<string, typeof snapshot.instances>()
    for (const instance of snapshot.instances) {
      if (instance.status !== 'cleanup-failed') continue
      failures.set(instance.identity.pluginId, [...(failures.get(instance.identity.pluginId) ?? []), instance])
    }
    return failures
  }, [snapshot])
  const installedById = useMemo(
    () => new Map(installed.map(item => [item.package.pluginId, item])),
    [installed],
  )
  const builtinIds = getBuiltinPluginIds()
  const packageIds = installed.map(item => item.package.pluginId).sort()
  // P53 D2：授权卡数据源 = builtin capability-consent 失败 + user-packages 阶段的
  // plugin_capability_denied（review B P1-1：外置包授权通路——否则外置 capability 包
  // 永远无法经宿主 UI 获得授权）
  const pendingConsent = bootstrapSnapshot.kind === 'degraded'
    ? bootstrapSnapshot.failures
      .filter(failure => failure.code === 'plugin_capability_denied')
      .map(failure => ({
        pluginId: failure.pluginId,
        pluginVersion: failure.pluginVersion ?? '0.0.0',
        capabilities: failure.capabilities ?? ['plugin.management'],
        message: failure.message,
      }))
    : []
  const managerActive = snapshot.active.some(identity => identity.pluginId === BUILTIN_PYLON_PLUGIN_MANAGER_ID)

  const setBuiltinEnabled = async (pluginId: string, enabled: boolean) => {
    await run(`${enabled ? '启用' : '停用'} ${pluginId}`, async () => {
      if (enabled) await bootstrap.retryPlugin(pluginId)
      else {
        const result = await runtime.disable(pluginId)
        if (!result.complete) return { ok: false, message: cleanupResultMessage(result) }
      }
      return { ok: true }
    })
  }

  const renderPlugin = (pluginId: string, builtin: boolean) => {
    const identity = activeById.get(pluginId)
    const installedItem = installedById.get(pluginId)
    const cleanupFailures = cleanupFailuresById.get(pluginId) ?? []
    const hasCleanupFailure = cleanupFailures.length > 0
    const enabled = builtin ? Boolean(identity) : (installedItem?.enabled ?? false)
    const manifest = installedItem?.package.manifest
    const productRequired = builtin && getBuiltinPluginCriticality(pluginId) === 'product-required'
    const contractDiagnostic = !builtin
      ? contractSnapshot.diagnostics.find(diagnostic => diagnostic.pluginId === pluginId)
      : undefined
    const bootstrapFailure = bootstrapSnapshot.kind === 'degraded'
      ? bootstrapSnapshot.failures.find(failure => failure.pluginId === pluginId)
      : undefined
    const displayName = builtin
      ? BUILTIN_PLUGIN_NAMES[pluginId] ?? pluginId
      : (typeof manifest?.name === 'string' ? manifest.name : pluginId)
    return (
      <article className="plugin-row" key={pluginId} data-plugin-runtime="v2" data-plugin-id={pluginId}>
        <div className="plugin-row-main">
          <span className={`plugin-status-dot ${identity ? 'is-active' : ''}`} aria-hidden="true" />
          <span className="plugin-row-copy">
            <span className="plugin-row-title">{displayName}</span>
            <span className="plugin-row-id">{pluginId}</span>
          </span>
          <span className={`plugin-type-badge ${builtin ? 'type-first-party' : 'type-package'}`}>
            {builtin ? '内置' : (typeof manifest?.kind === 'string' ? manifest.kind : '外置')}
          </span>
          {productRequired && <span className="plugin-type-badge type-first-party">产品运行必需</span>}
          <span className={`plugin-state-badge ${identity ? 'is-active' : ''}`}>
            {hasCleanupFailure ? (identity ? '运行中（有清理残留）' : '清理失败')
              : identity ? '运行中'
              : bootstrapFailure ? '启动失败'
                : contractDiagnostic?.code === 'waiting_activation' ? '等待激活事件'
                  : contractDiagnostic?.blocking ? '契约阻止'
                : bootstrapSnapshot.kind === 'safe-mode' && builtin ? '安全模式未启动'
                  : enabled ? '等待激活' : '已停用'}
          </span>
          {cleanupFailures.map(failure => (
            <span className="set-hint" key={failure.identity.key}>
              {[failure.cleanup?.deactivateError, ...(failure.cleanup?.scope.errors ?? [])]
                .filter((error): error is NonNullable<typeof error> => error !== undefined)
                .map(error => `${error.resourceId}: ${error.message}`)
                .join('；') || `${failure.cleanup?.scope.remaining ?? 0} 个资源仍待清理`}
            </span>
          ))}
          {contractDiagnostic && <span className="set-hint">{contractDiagnostic.message}</span>}
          <details className="plugin-technical">
            <summary>技术信息</summary>
            <div>API {PYLON_PLUGIN_API_VERSION} · {identity
              ? `${identity.version} · ${identity.packageInstanceId} · ${identity.runtimeInstanceId}`
              : '当前没有 Runtime 实例'}</div>
          </details>
        </div>
        <div className="plugin-row-actions">
          <button
            type="button"
            className="ps-btn sm"
            aria-label={`${(builtin ? Boolean(identity) : enabled) ? '停用' : '启用'} ${pluginId}`}
            disabled={busy !== null || hasCleanupFailure || Boolean(identity && productRequired)}
            onClick={() => void (builtin
              ? setBuiltinEnabled(pluginId, !identity)
              : run(`${enabled ? '停用' : '启用'} ${pluginId}`, () => service.setEnabled(pluginId, !enabled)))}
          >
            {(builtin ? Boolean(identity) : enabled) ? '停用' : '启用'}
          </button>
          {hasCleanupFailure && (
            <button
              type="button"
              className="ps-btn sm"
              aria-label={`重试清理 ${pluginId}`}
              disabled={busy !== null}
              onClick={() => void run(`重试清理 ${pluginId}`, async () => {
                for (const failure of cleanupFailures) {
                  const result = await runtime.retryCleanup(failure.identity.key)
                  if (!result.complete) return { ok: false, message: cleanupResultMessage(result) }
                }
                return { ok: true }
              })}
            >
              重试清理
            </button>
          )}
          {installedItem && identity && (
            <button type="button" className="ps-btn sm" disabled={busy !== null} onClick={() => void run(`重新加载 ${pluginId}`, () => service.reload(pluginId))}>
              重载
            </button>
          )}
          {installedItem && (
            <button type="button" className="ps-btn sm danger" disabled={busy !== null || hasCleanupFailure} onClick={() => {
              if (window.confirm(`确认卸载插件 ${pluginId}？`)) void run(`卸载 ${pluginId}`, () => service.uninstall(pluginId))
            }}>
              卸载
            </button>
          )}
        </div>
      </article>
    )
  }

  return (
    <div className="plugin-manager">
      <h3>插件</h3>
      <div className="set-hint">
        Pylon Plugin API {PYLON_PLUGIN_API_VERSION}；安装、停用、启用与热更新全部由统一 Runtime 执行。
      </div>
      <PluginCapabilityConsentCard pending={pendingConsent} bootstrap={bootstrap} />
      {managerActive && (
        <div className="set-preset-row">
          <button
            type="button"
            className="ps-btn primary sm"
            aria-label="打开插件管理器增强面板"
            onClick={() => window.dispatchEvent(new CustomEvent('pylon:open-settings', {
              detail: { domain: 'plugins', section: 'pylon-plugin-manager' },
            }))}
          >
            打开增强管理面板…
          </button>
        </div>
      )}
      <div className="plugin-overview" aria-label="插件概览">
        <span><strong>{snapshot.active.length}</strong> 个运行中</span>
        <span><strong>{installed.length}</strong> 个用户插件</span>
      </div>

      {(bootstrapSnapshot.kind === 'starting' || bootstrapSnapshot.kind === 'idle') && (
        <div className="set-hint" role="status">Kernel Plugin Host 正在启动…</div>
      )}
      {bootstrapSnapshot.kind === 'safe-mode' && (
        <div className="set-hint" role="status">Kernel 当前处于安全模式，Product Plugin 未自动启动。</div>
      )}
      {bootstrapSnapshot.kind === 'degraded' && (
        <div className="set-group" aria-label="插件启动故障">
          <div className="set-group-title" aria-expanded="true">启动故障</div>
          {bootstrapSnapshot.failures.map(failure => (
            <div className="plugin-row" key={`${failure.pluginId}:${failure.stage}`} role="status">
              <span className="plugin-row-id">{failure.pluginId}</span>
              <span className="set-hint">{failure.stage} · {failure.message}</span>
              {failure.retryable && (
                <button
                  type="button"
                  className="ps-btn sm"
                  onClick={() => { void bootstrap.retryPlugin(failure.pluginId) }}
                >
                  重试 {failure.pluginId}
                </button>
              )}
            </div>
          ))}
          <button type="button" className="ps-btn sm" onClick={() => { void bootstrap.startSafeMode() }}>
            进入安全模式
          </button>
        </div>
      )}

      <div className="set-group">
        <div className="set-group-title" aria-expanded="true">
          <span className="set-group-arrow">▾</span>
          用户插件
        </div>
        <div className="set-preset-row">
          <button type="button" className="ps-btn primary sm" disabled={busy !== null || !nativePackagesAvailable} onClick={() => void installOrUpdate()}>
            {busy === '安装/更新' ? '处理中…' : '安装/更新 api=1.0 包…'}
          </button>
          <button type="button" className="ps-btn sm" aria-label="从 zip 安装" disabled={busy !== null || !nativePackagesAvailable} onClick={() => void installFromZip()}>
            {busy === '从 zip 安装' ? '处理中…' : '从 zip 安装…'}
          </button>
          <button type="button" className="ps-btn sm" aria-label="从 URL 安装" disabled={busy !== null || !nativePackagesAvailable} onClick={() => void installFromUrl()}>
            {busy === '从 URL 安装' ? '处理中…' : '从 URL 安装…'}
          </button>
          <button type="button" className="ps-btn sm" disabled={busy !== null || !nativePackagesAvailable} onClick={() => void refresh().catch(error => appendLog(String(error)))}>
            刷新
          </button>
        </div>
        {installed.length === 0
          ? <div className="plugin-empty"><span aria-hidden="true">◇</span><strong>尚无用户插件</strong><small>从本地目录安装符合 API 1.0 的插件包。</small></div>
          : <div className="plugin-list">{packageIds.map(pluginId => renderPlugin(pluginId, false))}</div>}
      </div>

      <div className="set-group">
        <div className="set-group-title" aria-expanded="true">
          <span className="set-group-arrow">▾</span>
          内置组件
        </div>
        <div className="plugin-list">{builtinIds.sort().map(pluginId => renderPlugin(pluginId, true))}</div>
      </div>

      <div className="set-group">
        <div className="set-group-title" aria-expanded="true">
          <span className="set-group-arrow">▾</span>
          Shadow Update 诊断
        </div>
        {snapshot.switches.length === 0 && <div className="set-hint">本次运行尚无 Shadow Update。</div>}
        {snapshot.switches.map(item => (
          <div className="plugin-row" key={item.pluginId}>
            <span className="plugin-row-id">{item.pluginId}</span>
            <span className="set-hint">声明 {item.declaredMode} · 实际采用 {item.adoptedMode}</span>
          </div>
        ))}
      </div>

      <div className="set-group">
        <div className="set-group-title" aria-expanded="true">
          <span className="set-group-arrow">▾</span>
          最近日志
        </div>
        {log.length === 0 && <div className="set-hint">暂无操作日志。</div>}
        {log.map((line, index) => <div className="set-hint plugin-log-line" key={`${index}-${line}`} role="log">{line}</div>)}
      </div>
    </div>
  )
}
