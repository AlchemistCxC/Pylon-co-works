import manifestSource from './pylon-plugin.json'
import { createBuiltinPylonRenderersPlugin } from '../../builtinPylonRenderers.ts'
import { defineFirstPartyProductPackage } from '../../firstPartyProductPackage.ts'

export default defineFirstPartyProductPackage(manifestSource, import.meta.url, createBuiltinPylonRenderersPlugin)
