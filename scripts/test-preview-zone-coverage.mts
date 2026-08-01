import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { ZONE_FIELDS } from '../src/presets.ts'

const preview = readFileSync(new URL('../src/components/SettingsPreview.tsx', import.meta.url), 'utf8')
const toolConnector = readFileSync(new URL('../src/components/chat/ToolConnector.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const controlCenter = readFileSync(new URL('../src/components/ControlCenter.tsx', import.meta.url), 'utf8')
const controlCenterCss = readFileSync(new URL('../src/components/ControlCenter.css', import.meta.url), 'utf8')
const rightCss = readFileSync(new URL('../src/components/RightPanel.css', import.meta.url), 'utf8')

for (const zone of ['global', 'sidebar', 'chat', 'cc', 'right']) {
  assert.ok(ZONE_FIELDS[zone], `zone 缺失：${zone}`)
}

const representativeConsumers: Record<string, string[]> = {
  global: ['global', 'userName', 'userPrefix'],
  sidebar: ['sidebar'],
  chat: ['chat', 'toolConnectorMode', 'spinnerFramePreset'],
  cc: ['ControlCenter', 'ccStatusFontSize'],
  right: ['right-panel', 'rightWidth', 'rightBg'],
}
for (const [zone, tokens] of Object.entries(representativeConsumers)) {
  const source = zone === 'cc' ? `${preview}\n${app}\n${controlCenter}\n${controlCenterCss}`
    : zone === 'right' ? `${preview}\n${app}\n${rightCss}`
      : zone === 'chat' ? `${preview}\n${app}\n${toolConnector}`
        : `${preview}\n${app}`
  for (const token of tokens) assert.ok(source.includes(token), `${zone} 缺少代表性消费点：${token}`)
}

assert.match(preview, /zone === name \? \{ outline:/)
assert.match(preview, /z\('right'\)/)

const previewOnly = new Set(['rightBg', 'rightBgImage', 'rightWidth', 'rightTransparency', 'rightBlur'])
const uncoveredRightFields = ZONE_FIELDS.right.filter(field => !previewOnly.has(field))
assert.deepEqual(uncoveredRightFields, [], `right zone 主题字段未在 E-12 Preview 契约中登记：${uncoveredRightFields.join(', ')}`)

console.log('SettingsPreview zone/字段覆盖契约通过（5 zones；right zone 5 字段已登记）')
