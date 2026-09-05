/**
 * P53 D2 embedded plugin-manager panel (framework-free, plain DOM).
 *
 * Dogfood rule: all data and operations flow through the activation context's
 * `management` API — importing host singletons (pluginCompositionRoot etc.) is
 * forbidden. Styles come from pluginManagerPanel.css which consumes host visual
 * semantic tokens; no copied host opacity/shadow values.
 *
 * Pre-consent state: when `management` is absent the panel renders a consent
 * guide instead of throwing. After the user grants via the host authorization
 * card and the plugin retries activation, the panel becomes functional.
 */
import type { PluginManagementApi } from '../../../../../sdk/index.ts'

export interface PluginManagerPanelOptions {
  readonly management?: PluginManagementApi
  /** Directory picker provided by the host UI (the panel never imports tauri dialog). */
  readonly pickDirectory?: () => Promise<string | null>
  readonly onNotice?: (message: string) => void
}

const LOG_LIMIT = 12

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(label: string, className?: string): HTMLButtonElement {
  const node = el('button', className ?? 'pypm-btn', label) as HTMLButtonElement
  node.type = 'button'
  return node
}

function contributionSummaryLine(fact: {
  contributions: Readonly<Record<string, readonly string[]>>
}): string {
  const parts = Object.entries(fact.contributions).map(([surface, ids]) => `${surface} x${ids.length}`)
  return parts.length > 0 ? parts.join(' · ') : '无注册贡献'
}

export interface PluginManagerPanelHandle {
  readonly root: HTMLElement
  refresh(): void
  dispose(): void
}

export function mountPluginManagerPanel(
  container: HTMLElement,
  options: PluginManagerPanelOptions,
): PluginManagerPanelHandle {
  const root = el('div', 'pypm-panel')
  let disposed = false
  const log: string[] = []
  const notice = (message: string) => {
    log.push(`[${new Date().toLocaleTimeString()}] ${message}`)
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT)
    options.onNotice?.(message)
  }

  const runOperation = async (label: string, operation: () => Promise<void>) => {
    try {
      await operation()
      notice(`${label}成功`)
    } catch (error) {
      notice(`${label}失败：${error instanceof Error ? error.message : String(error)}`)
    }
    render()
  }

  // 贡献清单区块可见性必须跨 render 重建存活（re-render 会重跑 renderManager）
  let contributionVisible = false

  const renderConsentGuide = (parent: HTMLElement) => {
    const guide = el('div', 'pypm-consent')
    guide.append(
      el('h3', 'pypm-consent-title', '等待能力授权'),
      el('p', 'pypm-consent-text',
        '本插件声明了 plugin.management 能力。请在宿主「设置 → 插件」页的授权卡中批准后，重试激活本插件。'),
    )
    parent.append(guide)
  }

  const render = () => {
    if (disposed) return
    root.replaceChildren()
    if (!options.management) {
      renderConsentGuide(root)
      return
    }
    renderManager(root)
  }

  const renderManager = (parent: HTMLElement) => {
    const management = options.management!

    const overview = el('div', 'pypm-overview')
    overview.setAttribute('aria-label', '插件概览')
    parent.append(overview)

    const userPlugins = el('div', 'pypm-group')
    userPlugins.append(el('div', 'pypm-group-title', '用户插件'))
    const userActions = el('div', 'pypm-actions')
    const installButton = button('安装/更新包…', 'pypm-btn primary')
    installButton.disabled = !options.pickDirectory
    installButton.addEventListener('click', () => { void runInstall(management) })
    const refreshButton = button('刷新')
    const contributionButton = button('贡献清单')
    contributionButton.addEventListener('click', () => {
      contributionVisible = !contributionVisible
      render()
    })
    userActions.append(installButton, refreshButton, contributionButton)
    userPlugins.append(userActions)
    const userList = el('div', 'pypm-list')
    userPlugins.append(userList)
    parent.append(userPlugins)

    const builtins = el('div', 'pypm-group')
    builtins.append(el('div', 'pypm-group-title', '内置组件'))
    const builtinList = el('div', 'pypm-list')
    builtins.append(builtinList)
    parent.append(builtins)

    const bootstrap = el('div', 'pypm-group')
    bootstrap.append(el('div', 'pypm-group-title', '启动故障'))
    const bootstrapList = el('div', 'pypm-list')
    bootstrap.append(bootstrapList)
    parent.append(bootstrap)

    const diagnostics = el('div', 'pypm-group')
    diagnostics.append(el('div', 'pypm-group-title', '契约诊断'))
    const diagnosticsList = el('div', 'pypm-list')
    diagnostics.append(diagnosticsList)
    parent.append(diagnostics)

    const shadow = el('div', 'pypm-group')
    shadow.append(el('div', 'pypm-group-title', 'Shadow Update 诊断'))
    const shadowList = el('div', 'pypm-list')
    shadow.append(shadowList)
    parent.append(shadow)

    // P53 D5：运行时监管（进程）+ 存储配额 + 依赖关系图
    const processes = el('div', 'pypm-group')
    processes.append(el('div', 'pypm-group-title', '插件进程'))
    const processList = el('div', 'pypm-list')
    processes.append(processList)
    parent.append(processes)

    const storage = el('div', 'pypm-group')
    storage.append(el('div', 'pypm-group-title', '存储配额'))
    const storageList = el('div', 'pypm-list')
    storage.append(storageList)
    parent.append(storage)

    const dependencies = el('div', 'pypm-group')
    dependencies.append(el('div', 'pypm-group-title', '依赖与冲突'))
    const dependencyList = el('div', 'pypm-list')
    dependencies.append(dependencyList)
    parent.append(dependencies)

    let contributionsGroup: HTMLElement | undefined
    if (contributionVisible) {
      contributionsGroup = el('div', 'pypm-group')
      contributionsGroup.append(el('div', 'pypm-group-title', '贡献清单'))
      const contributionList = el('div', 'pypm-list')
      contributionsGroup.append(contributionList)
      parent.append(contributionsGroup)
      const facts = management.contributionOverview()
      if (facts.length === 0) {
        contributionList.append(el('p', 'pypm-hint', '当前无注册贡献。'))
      } else {
        for (const fact of facts) {
          const row = el('div', 'pypm-row')
          row.setAttribute('data-contribution-plugin', fact.pluginId)
          row.append(
            el('span', 'pypm-row-title', fact.pluginId),
            el('span', 'pypm-hint', contributionSummaryLine(fact)),
          )
          contributionList.append(row)
        }
      }
    }
    void contributionsGroup

    const logGroup = el('div', 'pypm-group')
    logGroup.append(el('div', 'pypm-group-title', '操作日志'))
    const logList = el('div', 'pypm-list')
    if (log.length === 0) logList.append(el('p', 'pypm-hint', '暂无操作日志。'))
    for (const line of log) logList.append(el('p', 'pypm-log-line', line))
    logGroup.append(logList)
    parent.append(logGroup)

    const loadAll = async () => {
      if (disposed) return
      try {
        const installed = await management.listInstalled()
        const runtime = management.runtimeOverview()
        const bootstrapState = management.bootstrapOverview()
        const contract = management.contractDiagnostics()

        overview.replaceChildren(
          el('span', undefined, `${runtime.activePluginIds.length} 个运行中`),
          el('span', undefined, `${installed.length} 个用户插件`),
        )

        userList.replaceChildren()
        if (installed.length === 0) {
          userList.append(el('p', 'pypm-hint', '尚无用户插件。'))
        }
        for (const item of installed) {
          const pluginId = item.package.pluginId
          const manifestName = typeof item.package.manifest?.name === 'string'
            ? item.package.manifest.name
            : pluginId
          const row = el('div', 'pypm-row')
          row.setAttribute('data-plugin-id', pluginId)
          const toggle = button(item.enabled ? '停用' : '启用')
          toggle.addEventListener('click', () => {
            void runOperation(`停用/启用 ${pluginId}`, () => management.setEnabled(pluginId, !item.enabled))
          })
          const reload = button('重载')
          reload.addEventListener('click', () => {
            void runOperation(`重载 ${pluginId}`, () => management.reload(pluginId))
          })
          const uninstall = button('卸载', 'pypm-btn danger')
          uninstall.addEventListener('click', () => {
            void runOperation(`卸载 ${pluginId}`, () => management.uninstall(pluginId))
          })
          const actions = el('div', 'pypm-actions')
          actions.append(toggle, reload, uninstall)
          row.append(
            el('span', 'pypm-row-title', manifestName),
            el('span', 'pypm-row-id', pluginId),
            el('span', 'pypm-row-state', item.enabled ? '已启用' : '已停用'),
            actions,
          )
          userList.append(row)
        }

        builtinList.replaceChildren()
        if (runtime.activePluginIds.length === 0) {
          builtinList.append(el('p', 'pypm-hint', '当前没有激活的内置组件。'))
        }
        for (const pluginId of runtime.activePluginIds) {
          const row = el('div', 'pypm-row')
          row.setAttribute('data-plugin-id', pluginId)
          const disable = button('停用')
          disable.addEventListener('click', () => {
            void runOperation(`停用 ${pluginId}`, () => management.setBuiltinEnabled(pluginId, false))
          })
          row.append(
            el('span', 'pypm-row-title', pluginId),
            el('span', 'pypm-row-state', '运行中'),
            disable,
          )
          builtinList.append(row)
        }

        bootstrapList.replaceChildren()
        if (bootstrapState.failures.length === 0) {
          bootstrapList.append(el('p', 'pypm-hint', `启动状态：${bootstrapState.state}。`))
        }
        for (const failure of bootstrapState.failures) {
          const row = el('div', 'pypm-row')
          row.append(
            el('span', 'pypm-row-id', failure.pluginId),
            el('span', 'pypm-hint', `${failure.stage} · ${failure.message}`),
          )
          bootstrapList.append(row)
        }

        diagnosticsList.replaceChildren()
        if (contract.diagnostics.length === 0) {
          diagnosticsList.append(el('p', 'pypm-hint', '当前无契约诊断。'))
        }
        for (const diagnostic of contract.diagnostics) {
          const row = el('div', 'pypm-row')
          row.append(
            el('span', 'pypm-row-id', diagnostic.pluginId),
            el('span', 'pypm-hint', `${diagnostic.code} · ${diagnostic.message}`),
          )
          diagnosticsList.append(row)
        }

        shadowList.replaceChildren()
        const cleanupFailures = runtime.instances.filter(instance => instance.status === 'cleanup-failed')
        if (cleanupFailures.length === 0) {
          shadowList.append(el('p', 'pypm-hint', '本次运行尚无 Shadow Update 诊断。'))
        } else {
          for (const instance of cleanupFailures) {
            const row = el('div', 'pypm-row')
            row.setAttribute('data-cleanup-failed', instance.pluginId)
            const retry = button('重试清理')
            retry.addEventListener('click', () => {
              void runOperation(`重试清理 ${instance.pluginId}`, async () => {
                const outcome = await management.retryCleanup(instance.runtimeInstanceId)
                if (!outcome.complete) throw new Error(outcome.message ?? '清理未完成')
              })
            })
            row.append(
              el('span', 'pypm-row-id', instance.pluginId),
              el('span', 'pypm-row-state', '清理失败'),
              retry,
            )
            shadowList.append(row)
          }
        }

        processList.replaceChildren()
        try {
          const processes = await management.processOverview()
          if (processes.length === 0) {
            processList.append(el('p', 'pypm-hint', '当前没有插件附带进程。'))
          }
          for (const process of processes) {
            const row = el('div', 'pypm-row')
            row.setAttribute('data-process-id', process.processId)
            const terminate = button('终止/重启')
            terminate.addEventListener('click', () => {
              void runOperation(`终止进程 ${process.pluginId}`, () => management.terminatePluginProcess(process.processId))
            })
            row.append(
              el('span', 'pypm-row-id', process.pluginId),
              el('span', 'pypm-row-state', `${process.status}（重启 ${process.restartAttempts} 次）`),
              terminate,
            )
            processList.append(row)
          }
        } catch (error) {
          processList.append(el('p', 'pypm-hint', `进程读取失败：${error instanceof Error ? error.message : String(error)}`))
        }

        storageList.replaceChildren()
        const usage = management.storageUsage()
        if (usage.length === 0) {
          storageList.append(el('p', 'pypm-hint', '当前没有插件持久数据。'))
        }
        for (const entry of usage) {
          const row = el('div', 'pypm-row')
          row.setAttribute('data-storage-plugin', entry.pluginId)
          const clear = button('清空')
          clear.addEventListener('click', () => {
            void runOperation(`清空存储 ${entry.pluginId}`, async () => {
              management.clearPluginStorage(entry.pluginId)
            })
          })
          row.append(
            el('span', 'pypm-row-id', entry.pluginId),
            el('span', 'pypm-row-state', `${entry.usedBytes}/${entry.budgetBytes} 字节 · ${entry.keyCount} 键`),
            clear,
          )
          storageList.append(row)
        }

        dependencyList.replaceChildren()
        try {
          const graph = await management.dependencyGraph()
          if (graph.length === 0) {
            dependencyList.append(el('p', 'pypm-hint', '当前无依赖声明。'))
          }
          for (const node of graph) {
            const row = el('div', 'pypm-row')
            row.setAttribute('data-dependency-node', node.pluginId)
            const relations = [
              ...(node.dependencies.length > 0 ? [`依赖 ${node.dependencies.join(', ')}`] : []),
              ...(node.optionalDependencies.length > 0 ? [`可选 ${node.optionalDependencies.join(', ')}`] : []),
              ...(node.conflicts.length > 0 ? [`冲突 ${node.conflicts.join(', ')}`] : []),
            ]
            row.append(
              el('span', 'pypm-row-title', node.pluginId),
              el('span', 'pypm-row-state', node.builtin ? '内置' : '外置'),
              el('span', 'pypm-hint', relations.length > 0 ? relations.join(' · ') : '无依赖'),
            )
            dependencyList.append(row)
          }
        } catch (error) {
          dependencyList.append(el('p', 'pypm-hint', `依赖图读取失败：${error instanceof Error ? error.message : String(error)}`))
        }
      } catch (error) {
        notice(`读取插件状态失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    refreshButton.addEventListener('click', () => { void loadAll() })

    const runInstall = async (api: PluginManagementApi) => {
      if (!options.pickDirectory) return
      let sourcePath: string | null
      try {
        sourcePath = await options.pickDirectory()
      } catch (error) {
        notice(`选择目录失败：${error instanceof Error ? error.message : String(error)}`)
        return
      }
      if (!sourcePath) return
      await runOperation('安装/更新', () => api.installOrUpdate(sourcePath))
    }

    void loadAll()
  }

  container.append(root)
  render()

  return {
    root,
    refresh: render,
    dispose() {
      disposed = true
      root.remove()
    },
  }
}
