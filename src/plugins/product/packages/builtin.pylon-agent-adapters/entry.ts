import manifestSource from './pylon-plugin.json' with { type: 'json' }
import { createBuiltinPylonAgentAdaptersPlugin } from '../../builtinPylonAgentAdapters.ts'
import { defineFirstPartyProductPackage } from '../../firstPartyProductPackage.ts'

export default defineFirstPartyProductPackage(manifestSource, import.meta.url, createBuiltinPylonAgentAdaptersPlugin)
