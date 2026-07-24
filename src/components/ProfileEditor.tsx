import { useState } from 'react'
import { useStore } from '../store'
import './ProfileEditor.css'

export default function ProfileEditor({ onClose }: { onClose: () => void }) {
  const { activeProfileId, profiles, addProfile, setActiveProfile } = useStore()
  const profile = profiles.find(p => p.id === activeProfileId)!

  const [name, setName] = useState(profile.name)
  const [avatar, setAvatar] = useState(profile.avatar || '')
  const [persona, setPersona] = useState(profile.persona)

  const save = () => {
    addProfile({ ...profile, name, avatar: avatar || undefined, persona })
    onClose()
  }

  return (
    <div className="profile-editor-overlay" onClick={onClose}>
      <div className="profile-editor" onClick={e => e.stopPropagation()}>
        <div className="pe-header">
          <span>Edit Profile</span>
          <button onClick={onClose}>✕</button>
        </div>

        <div className="pe-body">
          <label className="pe-label">Name</label>
          <input className="pe-input" value={name} onChange={e => setName(e.target.value)}/>

          <label className="pe-label">Avatar (optional URL)</label>
          <input className="pe-input" value={avatar} onChange={e => setAvatar(e.target.value)} placeholder="https://... or file:///C:/..."/>

          <label className="pe-label">Persona</label>
          <textarea className="pe-textarea" value={persona} onChange={e => setPersona(e.target.value)} rows={6}
            placeholder="Describe how the AI should behave..."/>

          <div className="pe-actions">
            <button className="pe-cancel" onClick={onClose}>Cancel</button>
            <button className="pe-save" onClick={save}>Save</button>
          </div>
        </div>
      </div>
    </div>
  )
}
