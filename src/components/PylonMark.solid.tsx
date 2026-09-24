interface PylonMarkProps {
  size?: number
  className?: string
  title?: string
}

/** Pylon 品牌标记（Solid 版，#279）：六边形外框中的三个正三角对称 Agent 节点。与
 * `PylonMark.tsx`（React 版）保持同构 SVG——类名是首方样式的消费契约，逐字段一致。 */
export default function PylonMark(props: PylonMarkProps) {
  return (
    <svg
      class={['pylon-mark', props.className].filter(Boolean).join(' ')}
      data-brand-mark="pylon"
      width={props.size ?? 24}
      height={props.size ?? 24}
      viewBox="0 0 64 64"
      role="img"
      aria-label={props.title ?? 'Pylon'}
    >
      <path class="pylon-mark-frame" d="M32 7 53 19v26L32 57 11 45V19Z" />
      <circle class="pylon-mark-node" cx="32" cy="21.215" r="4" />
      <circle class="pylon-mark-node" cx="20" cy="42" r="4" />
      <circle class="pylon-mark-node" cx="44" cy="42" r="4" />
      <path class="pylon-mark-links" d="m30 24.679-8 13.857m20 0-8-13.857M24 42h16" />
    </svg>
  )
}
