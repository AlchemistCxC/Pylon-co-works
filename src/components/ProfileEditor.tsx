import { useState } from 'react'
import { useStore } from '../store'
import './ProfileEditor.css'

export default function ProfileEditor({ onClose }: { onClose: () => void }) {
  const profiles = useStore(s => s.profiles)
  const activeProfileId = useStore(s => s.activeProfileId)
  const addProfile = useStore(s => s.addProfile)
  const setActiveProfile = useStore(s => s.setActiveProfile)
  const profile = profiles.find(p => p.id === activeProfileId) || profiles[0]

  const [name, setName] = useState(profile?.name || '')
  const [avatar, setAvatar] = useState(profile?.avatar || '')
  const [persona, setPersona] = useState(profile?.persona || '')
  const [model, setModel] = useState(profile?.model || 'deepseek-v4-flash')

  const save = () => {
    if (!name.trim()) return
    const id = (profile && profiles.includes(profile)) ? profile.id : Date.now().toString(36)
    // Use addProfile if new, or update existing via store
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
          <h3>Edit Profile</h3>
          <button className="pe-close" onClick={onClose}>✕</button>
        </div>
        <label className="pe-label">Name</label>
        <input className="pe-input" value={name} onChange={e => setName(e.target.value)}/>
        <label className="pe-label">Avatar (optional URL)</label>
        <input className="pe-input" value={avatar} onChange={e => setAvatar(e.target.value)} placeholder="https://... or file:///C:/..."/>
        <label className="pe-label">Persona</label>
        <textarea className="pe-textarea" rows={5} value={persona} onChange={e => setPersona(e.target.value)} placeholder="系统提示词..."/>
        <label className="pe-label">Model</label>
        <select className="pe-input" value={model} onChange={e => setModel(e.target.value)}>
          <option value="deepseek-v4-flash">deepseek-v4-flash</option>
          <option value="deepseek-v4-pro">deepseek-v4-pro</option>
          <option value="deepseek-v4">deepseek-v4</option>
          <option value="qwen2.5:1.5b">qwen2.5:1.5b (Ollama)</option>
          <option value="deepseek-r1">deepseek-r1</option>
        </select>
        <div className="pe-actions">
          <button className="pe-btn" onClick={onClose}>Cancel</button>
          <button className="pe-btn primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  )
}
