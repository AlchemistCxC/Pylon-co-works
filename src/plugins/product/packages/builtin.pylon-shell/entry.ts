import manifestSource from './pylon-plugin.json' with { type: 'json' }
import { createBuiltinPylonShellPlugin } from '../../builtinPylonShell.ts'
import { defineFirstPartyProductPackage } from '../../firstPartyProductPackage.ts'

export default defineFirstPartyProductPackage(manifestSource, import.meta.url, createBuiltinPylonShellPlugin)
