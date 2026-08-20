import { strict as assert } from 'node:assert'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeCustomPresets } from '../src/customPresets.ts'
import {
  createWorkbenchSkinFixtureSet,
  validateWorkbenchSkinFixtureSet,
} from '../src/domains/workbench/workbenchSkinContract.ts'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const outputPath = resolve(projectRoot, 'src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json')
const customPresetBaselinePath = resolve(projectRoot, 'src/renderers/solid-workbench/__fixtures__/custom-presets-baseline.json')

async function loadCustomPresets() {
  try {
    const raw = JSON.parse(await readFile(customPresetBaselinePath, 'utf8'))
    return normalizeCustomPresets(raw)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') return []
    throw error
  }
}

const fixtureSet = createWorkbenchSkinFixtureSet(
  await loadCustomPresets(),
  args.has('--write') ? new Date().toISOString() : 'contract-check',
)
const errors = validateWorkbenchSkinFixtureSet(fixtureSet)
assert.deepEqual(errors, [], `Workbench 皮肤 contract 失败：\n${errors.join('\n')}`)

if (args.has('--write')) {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(fixtureSet, null, 2)}\n`, 'utf8')
  console.log(`已写入 ${outputPath}`)
}

console.log([
  `Workbench 皮肤 contract 通过`,
  `内置预设 ${fixtureSet.source.builtinPresetIds.length} 个`,
  `自定义预设 ${fixtureSet.source.customPresetIds.length} 个`,
  `主题字段 ${fixtureSet.source.themeSettingCount} 个`,
  `Workbench CSS variables ${fixtureSet.source.cssVariableCount} 个`,
  `fixture ${fixtureSet.fixtures.length} 个`,
].join('；'))
