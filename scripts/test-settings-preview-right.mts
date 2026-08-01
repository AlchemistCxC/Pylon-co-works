import { readFileSync } from 'node:fs'

const preview = readFileSync('src/components/SettingsPreview.tsx', 'utf8')
const css = readFileSync('src/components/Settings.css', 'utf8') + readFileSync('src/components/RightPanel.css', 'utf8')

const required = [
  'className="right-panel pv-right-panel"',
  'rightBg', 'rightBgImage', 'rightWidth', 'rightTransparency', 'rightBlur',
  "'--right-bg'", "'--right-bg-image'", "'--right-width'", "'--right-transparency'", "'--right-blur'",
  "z('right')",
]
for (const token of required) {
  if (!preview.includes(token)) throw new Error(`missing preview token: ${token}`)
}
for (const token of ['.right-panel', 'position:absolute', 'width:var(--right-width', 'background:var(--right-bg', 'background-image:var(--right-bg-image', 'opacity:var(--right-transparency', 'blur(var(--right-blur']) {
  if (!css.includes(token)) throw new Error(`missing css token: ${token}`)
}
console.log('settings-preview-right contract: PASS')
