/** Value contracts shared by connector projection and Solid DOM rendering.
 * Kept outside JSX modules so TypeScript consumers do not import a framework compiler boundary.
 */
import type { ToolConnectorStatus } from '../../domains/tool/toolPresentation.ts'
import type { ToolVisualState } from '../../domains/tool/status.ts'
import type { WorkbenchAppearanceSnapshot } from '../../domains/workbench/appearance.ts'

export type ToolConnectorAppearance = Pick<WorkbenchAppearanceSnapshot,
  'toolConnectorMode' | 'toolConnectorColor' | 'toolConnectorStyle' | 'toolConnectorWidth' | 'toolConnectorOpacity'>

export interface SolidToolConnectorEdge {
  key: string
  fromMessageId: string
  toMessageId: string
  status: ToolConnectorStatus
  visualState?: ToolVisualState
  appearance: ToolConnectorAppearance
}

