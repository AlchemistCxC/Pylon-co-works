import type { ReactNode } from 'react'

export type RightPanelTab = 'workspace' | 'logs' | 'reserved-1' | 'reserved-2'

export interface RightPanelTabDefinition {
  id: RightPanelTab
  label: string
}

export interface PanelStatusProps {
  kind: 'loading' | 'empty' | 'error'
  title: string
  detail?: string
  retry?: () => void
}

export interface ReservedTabProps {
  title: string
  detail: string
  icon?: ReactNode
}
