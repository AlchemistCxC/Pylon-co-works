import PrismSheet from '../components/PrismSheet'

export default function PrismManagerSheetView() {
  // #154：左列折叠不再由本 Sheet 透传——可见性归布局层（.layout[data-sidebar]）。
  return <div className="sheet-tool-view"><PrismSheet /></div>
}
