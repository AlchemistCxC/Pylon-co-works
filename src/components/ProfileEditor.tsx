import { useState } from 'react'
import { useStore } from '../store'
import './ProfileEditor.css'

export default function ProfileEditor({ onClose }: { onClose: () => void }) {
  const profiles = useStore(s => s.profiles)
  const activeProfileId = useStore(s => s.activeProfileId)
  const addProfile = useStore(s => s.addProfile)
  const setActiveProfile = useStore(s => s.setActiveProfile)
  const sessionConfig = useStore(s => s.sessionConfig)
  const profile = profiles.find(p => p.id === activeProfileId) || profiles[0]

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
    if (profile && profiles.includes(profile)) {
      useStore.setState(s => ({
        profiles: s.profiles.map(p => p.id === id ? { id, name, avatar, persona, model } : p),
        activeProfileId: id,
      }))
    } else {
      addProfile({ id, name, avatar, persona, model })
      setActiveProfile(id)
    }
    onClose()
  }

  return (
    <div className="profile-editor-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="profile-editor">
        <div className="pe-header">
          <h3>编辑 Profile</h3>
          <button className="pe-close" onClick={onClose}>✕</button>
        </div>
        <div className="pe-body">
          <div className="pe-field">
            <label className="pe-label">名称</label>
            <input className="pe-input" value={name} onChange={e => setName(e.target.value)}
              placeholder="Profile 名称" autoFocus />
          </div>
          <div className="pe-field">
            <label className="pe-label">头像 URL（可选）</label>
            <input className="pe-input" value={avatar} onChange={e => setAvatar(e.target.value)}
              placeholder="https://... 或留空" />
          </div>
          <div className="pe-field">
            <label className="pe-label">系统提示词 (Persona)</label>
            <textarea className="pe-textarea" rows={6} value={persona} onChange={e => setPersona(e.target.value)}
              placeholder="输入系统提示词..." />
          </div>
          <div className="pe-field">
            <label className="pe-label">默认模型</label>
            <select className="pe-select" value={model} onChange={e => setModel(e.target.value)}>
              {models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>
        <div className="pe-footer">
          <button className="pe-btn" onClick={onClose}>取消</button>
          <button className="pe-btn primary" onClick={save} disabled={!name.trim()}>保存</button>
        </div>
      </div>
    </div>
  )
}
