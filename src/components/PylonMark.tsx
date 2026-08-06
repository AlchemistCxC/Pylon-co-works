interface PylonMarkProps {
  size?: number
  className?: string
  title?: string
}

/** Pylon 品牌标记：三个 Agent 节点组成协作拓扑。 */
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
      <path className="pylon-mark-frame" d="M32 7 53 19v26L32 57 11 45V19Z" />
      <circle className="pylon-mark-node" cx="32" cy="18" r="4" />
      <circle className="pylon-mark-node" cx="20" cy="42" r="4" />
      <circle className="pylon-mark-node" cx="44" cy="42" r="4" />
      <path className="pylon-mark-links" d="m32 22-10 16m20 0L32 22m-8 20h16" />
    </svg>
  )
}
