import manifestSource from './pylon-plugin.json' with { type: 'json' }
import { createBuiltinPylonGatewayPlugin } from '../../builtinPylonGateway.ts'
import { defineFirstPartyProductPackage } from '../../firstPartyProductPackage.ts'

export default defineFirstPartyProductPackage(manifestSource, import.meta.url, createBuiltinPylonGatewayPlugin)
