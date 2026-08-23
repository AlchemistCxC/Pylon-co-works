import type { ReactNode } from 'react'
import { useRef, useState } from 'react'
import { IS_TAURI } from '../../infrastructure/tauri/env'
import { buildExportPayloadAsync, configFileName, preflightImportPayload } from '../../configExportImport'
import { loadRetentionPolicyPayload } from '../../retentionPolicyRepository'
import { syncImportedRetentionPolicy } from '../../retentionPolicyRepository'
import { useIdentityStore } from '../../identityStore'
import { useWorkspaceStore } from '../../workspaceStore'
import { reportRuntimeError } from '../../runtimeError'
import { selectUserDataRepository } from '../../userDataRepository'
import { importConfigurationTransaction } from '../../application/transactions/importConfigurationTransaction'

export default function ConfigBackupPanel() {
  const [msg, setMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const isTauri = IS_TAURI
  const doExport = async () => {
    try {
      // I14-W8：Tauri 模式导出聚合后端 versioned user store（profiles/sessions envelope
      // 权威源）；browser 模式无后端 → 与原 buildExportPayload 等价
      // I13-W6：保留策略后端权威 payload 聚合（Tauri；browser 走 localStorage key）
      const repo = isTauri ? selectUserDataRepository() : null
      const json = await buildExportPayloadAsync(localStorage, repo ? {
        loadProfiles: async () => (await repo.load('profiles'))?.payload ?? null,
        loadSessions: async () => (await repo.load('sessions'))?.payload ?? null,
        loadRetention: async () => {
          const payload = await loadRetentionPolicyPayload()
          return payload ? { payload } : null
        },
      } : undefined)
      const fileName = configFileName()
      if (isTauri) {
        const { save } = await import('@tauri-apps/plugin-dialog')
        const path = await save({ defaultPath: fileName, filters: [{ name: 'Pylon 配置', extensions: ['json'] }] })
        if (path) {
          const { writeTextFile } = await import('@tauri-apps/plugin-fs')
          await writeTextFile(path, json)
          setMsg('已导出配置')
        }
      } else {
        const blob = new Blob([json], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = fileName; a.click()
        URL.revokeObjectURL(url)
        setMsg('已导出配置')
      }
    } catch (cause) { setMsg(`导出失败：${String(cause)}`) }
  }
  const doImport = async (file?: File) => {
    try {
      let json: string | null = null
      if (file) {
        json = await file.text()
      } else if (isTauri) {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const selected = await open({ multiple: false, filters: [{ name: 'Pylon 配置', extensions: ['json'] }] })
        if (!selected) return
        const { readTextFile } = await import('@tauri-apps/plugin-fs')
        json = await readTextFile(selected as string)
      }
      if (json === null) return
      const result = await importConfigurationTransaction(json, {
        storage: localStorage,
        preflight: preflightImportPayload,
        rehydrate: () => {
          // I14-W6 CR-01：导入后强制本地读回（读取刚写入的 localStorage）+ 写穿后端，
          // 避免 Tauri 模式后端权威读回覆盖导入值（导入静默失效）
          useIdentityStore.getState().hydrateFromLocal()
          useWorkspaceStore.getState().hydrateWorkspaceSheets()
        },
        reportError: (action, error) => reportRuntimeError(action, error),
      })
      // I13-W6 CR-001：仅当导入 payload 确含保留策略 key 时写穿后端权威（防本地残留盲写覆盖）
      if (result.ok) {
        syncImportedRetentionPolicy(localStorage, result.value).catch(error => {
          reportRuntimeError('导入保留策略', error)
        })
      }
      setMsg(result.ok
        ? `已导入 ${result.value.length} 项配置`
        : `导入失败：${result.message}`)
    } catch (cause) { setMsg(`导入失败：${String(cause)}`) }
  }
  return (
    <Group title="配置备份">
      <div className="set-preset-row">
        <button type="button" className="ps-btn sm" onClick={doExport}>导出配置</button>
        <button type="button" className="ps-btn sm" onClick={() => fileRef.current?.click()}>导入配置</button>
        <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
          onChange={e => { const file = e.target.files?.[0]; if (file) void doImport(file); e.target.value = '' }} />
      </div>
      {msg && <div className="set-hint">{msg}</div>}
    </Group>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="set-group">
      <button type="button" className="set-group-title" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="set-group-arrow">{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && children}
    </div>
  )
}
