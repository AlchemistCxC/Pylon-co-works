/**
 * TS-WI02：三个生产 wrapper 必须保留 transaction 传入的 agentId。
 *
 * 运行时行为由 owner-aware transaction 测试覆盖；此处用 Vite raw import 固定生产接线形状，
 * 避免 Node 类型进入浏览器 tsconfig。
 */
import { describe, expect, it } from 'vitest'
import overviewSource from '../sheets/OverviewSheetView.tsx?raw'
import historySource from '../sheets/history/HistorySheetView.tsx?raw'
import searchSource from '../sheets/search/SearchSheetView.tsx?raw'

const files = [
  ['src/sheets/OverviewSheetView.tsx', overviewSource],
  ['src/sheets/history/HistorySheetView.tsx', historySource],
  ['src/sheets/search/SearchSheetView.tsx', searchSource],
] as const

describe('TS-WI02 production addSession owner wiring', () => {
  for (const [file, source] of files) {
    it(file, () => {
      expect(source).toMatch(/addSession:\s*\(name, agentId\)\s*=>\s*useIdentityStore\.getState\(\)\.addSession\(name, agentId\)/)
    })
  }
})
