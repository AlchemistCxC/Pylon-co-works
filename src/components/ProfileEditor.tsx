import { useState } from 'react'
import { useIdentityStore } from '../identityStore'
import { useRuntimeStore } from '../runtimeStore'
import './SettingsCommon.css'
import './ProfileEditor.css'

export default function ProfileEditor({ onClose }: { onClose: () => void }) {
  const profiles = useIdentityStore(s => s.profiles)
  const activeProfileId = useIdentityStore(s => s.activeProfileId)
  const addProfile = useIdentityStore(s => s.addProfile)
  const setActiveProfile = useIdentityStore(s => s.setActiveProfile)
  const sessionConfig = useRuntimeStore(s => s.sessionConfig)
  // activeProfileId 失效时不回退 profiles[0]：否则 save 走编辑分支、覆写第一个 profile。
  // find 不到即进入新建分支（Date.now 新 id）。
  const profile = profiles.find(p => p.id === activeProfileId)

  const [name, setName] = useState(profile?.name || '')
  const [avatar, setAvatar] = useState(profile?.avatar || '')
  const [persona, setPersona] = useState(profile?.persona || '')
  const [model, setModel] = useState(profile?.model || 'deepseek-v4-flash')

  // 从任意session的config里拿model列表，否则用fallback
  const models = (() => {
    for (const cfg of Object.values(sessionConfig)) {
      if (cfg.models?.length) return cfg.models
    }
    return ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4', 'qwen2.5:1.5b', 'deepseek-r1']
  })()

  const save = () => {
    if (!name.trim()) return
    const id = (profile && profiles.includes(profile)) ? profile.id : Date.now().toString(36)
    addProfile({ id, name, avatar, persona, model })
    setActiveProfile(id)
    onClose()
  }

  const dirty = name !== (profile?.name || '')
    || avatar !== (profile?.avatar || '')
    || persona !== (profile?.persona || '')
    || model !== (profile?.model || 'deepseek-v4-flash')

  const requestClose = () => {
    if (dirty && !window.confirm('放弃未保存的 Profile 修改？')) return
    onClose()
  }

  return (
    <div className="profile-editor-overlay" onClick={e => { if (e.target === e.currentTarget) requestClose() }}>
      <div className="profile-editor settings-surface settings-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-editor-title">
        <div className="pe-header settings-dialog-header">
          <div>
            <h3 id="profile-editor-title" className="settings-dialog-title">编辑 Profile</h3>
            <p className="settings-dialog-description">定义这个 Profile 的身份信息、Persona 与默认模型。</p>
          </div>
          <button className="pe-close settings-dialog-close" onClick={requestClose} aria-label="关闭 Profile 设置">✕</button>
        </div>
        <div className="pe-body">
          <div className="pe-identity-preview">
            <div className="pe-avatar-preview">{avatar ? <img src={avatar} alt="" onError={e => { e.currentTarget.style.display = 'none' }} /> : (name.trim()[0] || '?').toUpperCase()}</div>
            <div><strong>{name.trim() || '未命名 Profile'}</strong><span>{model || '未选择默认模型'}</span></div>
          </div>
          <div className="pe-section-title">身份信息</div>
          <div className="pe-field">
            <label className="pe-label" htmlFor="profile-name">名称</label>
            <input id="profile-name" className="pe-input settings-control" value={name} onChange={e => setName(e.target.value)}
              placeholder="Profile 名称" autoFocus />
          </div>
          <div className="pe-field">
            <label className="pe-label" htmlFor="profile-avatar">头像 URL <span>可选</span></label>
            <input id="profile-avatar" className="pe-input settings-control" value={avatar} onChange={e => setAvatar(e.target.value)}
              placeholder="https://... 或留空" />
          </div>
          <div className="pe-section-title">Persona</div>
          <div className="pe-field">
            <label className="pe-label" htmlFor="profile-persona">系统提示词</label>
            <textarea id="profile-persona" className="pe-textarea settings-control" rows={8} value={persona} onChange={e => setPersona(e.target.value)}
              placeholder="输入系统提示词..." />
            <p className="pe-hint">{persona.length} 字 · {persona ? persona.split(/\r?\n/).length : 0} 行。新会话会使用此 Persona，Session Prompt 可进一步覆盖。</p>
          </div>
          <div className="pe-section-title">默认运行配置</div>
          <div className="pe-field">
            <label className="pe-label" htmlFor="profile-model">默认模型</label>
            <select id="profile-model" className="pe-select settings-control" value={model} onChange={e => setModel(e.target.value)}>
              {models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>
        <div className="pe-footer settings-dialog-footer">
          <span className={`pe-dirty ${dirty ? 'active' : ''}`}>
            {dirty ? '有未保存修改' : '所有修改已保存'}
          </span>
          <div className="pe-footer-actions settings-dialog-actions">
            <button className="pe-btn settings-action" onClick={requestClose}>取消</button>
            <button className="pe-btn primary settings-action primary" onClick={save} disabled={!name.trim()}>保存</button>
          </div>
        </div>
      </div>
    </div>
  )
}
