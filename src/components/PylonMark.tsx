interface PylonMarkProps {
  size?: number
  className?: string
  title?: string
}

/** Pylon 品牌标记：正三角形中的三个对称 Agent 节点。 */
export default function PylonMark({ size = 24, className, title = 'Pylon' }: PylonMarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={title}
      focusable="false"
    >
      <path className="pylon-mark-frame" d="M32 9.48 58 54.52H6Z" />
      <circle className="pylon-mark-node" cx="32" cy="18.88" r="4" />
      <circle className="pylon-mark-node" cx="18" cy="43.12" r="4" />
      <circle className="pylon-mark-node" cx="46" cy="43.12" r="4" />
      <path className="pylon-mark-links" d="m30 22.34-10 17.32m24 0-10-17.32M22 43.12h20" />
    </svg>
  )
}
