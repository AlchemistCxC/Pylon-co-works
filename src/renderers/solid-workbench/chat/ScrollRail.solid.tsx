/** @jsxImportSource solid-js */
/**
 * 聊天滚动导航轨（#486 项4 自 WorkbenchContent.solid.tsx 拆出的子组件；行为不变）。
 * 回顶/回底按钮 + 轨道寻道/键盘寻道 + 拖拽拇指；几何与交互判定全部来自
 * `createChatScrollController`，本组件只做呈现与事件转接。
 */
import type { ChatScrollController } from './createChatScrollController.solid.tsx'

export function SolidScrollRail(props: { controller: ChatScrollController }) {
  const controller = () => props.controller
  return (
    <div class="solid-workbench-scroll-rail" role="group" aria-label="聊天滚动导航">
      <button
        type="button"
        class="scroll-rail-btn scroll-top-btn"
        data-scroll-action="top"
        aria-label="回到顶部"
        title="回到顶部"
        onClick={controller().scrollToTop}
      >▲</button>
      <div
        ref={node => { controller().registerScrollRailTrack(node) }}
        class="solid-workbench-scroll-track"
        role="scrollbar"
        aria-label="聊天滚动位置"
        aria-orientation="vertical"
        aria-valuemin="0"
        aria-valuemax={controller().scrollRailThumb().maxScroll}
        aria-valuenow={Math.round(controller().scrollRailMetrics().scrollTop)}
        tabIndex="0"
        onPointerDown={controller().seekScrollRailTrack}
        onClick={controller().seekScrollRailTrack}
        onKeyDown={controller().handleScrollRailKeyDown}
      >
        <div
          class="solid-workbench-scroll-thumb"
          data-scrollable={controller().scrollRailThumb().visible ? 'true' : 'false'}
          aria-hidden="true"
          style={{
            height: `${controller().scrollRailThumb().height}px`,
            transform: `translateY(${controller().scrollRailThumb().offset}px)`,
          }}
          onPointerDown={controller().beginScrollRailThumbDrag}
        />
      </div>
      <button
        type="button"
        class="scroll-rail-btn scroll-bottom-btn"
        data-scroll-action="bottom"
        aria-label="回到底部"
        title="回到底部"
        onClick={controller().resumeBottomFollow}
      >▼</button>
    </div>
  )
}
