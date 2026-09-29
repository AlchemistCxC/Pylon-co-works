/** Per-viewport input intent. Owns only a touch origin; never writes DOM or prevents native scrolling. */
export function createScrollUserIntent(onScrollBack: () => void) {
  let touchStartClientY: number | undefined
  return {
    onWheel(event: WheelEvent) {
      if (event.deltaY < 0 && Math.abs(event.deltaY) > Math.abs(event.deltaX)) onScrollBack()
    },
    onKeyDown(event: KeyboardEvent) {
      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') onScrollBack()
    },
    onTouchStart(event: TouchEvent) {
      touchStartClientY = event.touches[0]?.clientY
    },
    onTouchMove(event: TouchEvent) {
      const clientY = event.touches[0]?.clientY
      if (touchStartClientY === undefined || clientY === undefined) return
      const deltaY = clientY - touchStartClientY
      if (Math.abs(deltaY) <= 8) return
      touchStartClientY = undefined
      // Finger moving down scrolls the viewport back toward older content.
      if (deltaY > 8) onScrollBack()
    },
    onTouchEnd() { touchStartClientY = undefined },
  }
}
