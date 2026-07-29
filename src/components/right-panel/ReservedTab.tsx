import PanelStatus from './PanelStatus'
import type { ReservedTabProps } from './rightPanelTypes'

export default function ReservedTab({ title, detail }: ReservedTabProps) {
  return (
    <div className="panel-tab">
      <PanelStatus kind="empty" title={title} detail={detail} />
    </div>
  )
}
