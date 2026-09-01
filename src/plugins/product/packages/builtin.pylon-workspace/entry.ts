import manifestSource from './pylon-plugin.json'
import { createBuiltinPylonWorkspacePlugin } from '../../builtinPylonWorkspace.ts'
import { defineFirstPartyProductPackage } from '../../firstPartyProductPackage.ts'

export default defineFirstPartyProductPackage(manifestSource, import.meta.url, createBuiltinPylonWorkspacePlugin)
