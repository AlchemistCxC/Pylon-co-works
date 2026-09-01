import manifestSource from './pylon-plugin.json'
import { createBuiltinPylonToolsPlugin } from '../../builtinPylonTools.ts'
import { defineFirstPartyProductPackage } from '../../firstPartyProductPackage.ts'

export default defineFirstPartyProductPackage(manifestSource, import.meta.url, createBuiltinPylonToolsPlugin)
