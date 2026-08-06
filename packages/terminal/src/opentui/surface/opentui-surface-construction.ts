import {
  BoxRenderable,
  EditBufferRenderable,
  ScrollBarRenderable,
  ScrollBoxRenderable,
  CliRenderEvents,
  TextRenderable,
  RGBA,
  SystemClock,
  type CliRenderer,
  type MouseEvent,
} from "@opentui/core"
import { Clock, Effect } from "effect"
import { isFollowing } from "../../presentation/transcript/transcript-viewport"
import { boundedThreadSidebarWidth } from "../../state/model/terminal-layout-state"
import { colors, spacing } from "../../presentation/terminal/terminal-theme"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import { ToolSpinner } from "../rendering/opentui-spinner"
import { SurfaceLifecycleCleanup } from "./opentui-lifecycle-cleanup"
import { type Handlers, type SurfaceOptions } from "./opentui-surface-state"

class SidebarScrollBoxRenderable extends ScrollBoxRenderable {
  onWindowChanged: (() => void) | undefined
  private virtualHeight = 0
  override get scrollHeight(): number {
    return this.virtualHeight
  }
  override get scrollTop(): number {
    return super.scrollTop
  }
  override set scrollTop(value: number) {
    this.applyVirtualGeometry()
    super.scrollTop = value
    this.content.translateY = 0
    this.onWindowChanged?.()
  }
  setVirtualHeight(value: number): void {
    this.virtualHeight = Math.max(0, Math.floor(value))
    if (this.applyVirtualGeometry()) this.onWindowChanged?.()
  }
  syncVirtualScroll(): void {
    if (this.applyVirtualGeometry()) this.onWindowChanged?.()
  }
  override render(...args: Parameters<ScrollBoxRenderable["render"]>): void {
    this.applyVirtualGeometry()
    super.render(...args)
  }
  private applyVirtualGeometry(): boolean {
    const previousTop = super.scrollTop
    this.verticalScrollBar.viewportSize = this.viewport.height
    this.verticalScrollBar.scrollSize = Math.max(this.virtualHeight, this.viewport.height)
    this.verticalScrollBar.scrollPosition = Math.min(
      previousTop,
      Math.max(0, this.virtualHeight - this.viewport.height),
    )
    this.content.translateY = 0
    return super.scrollTop !== previousTop
  }
}
export class ProjectedEditorRenderable extends EditBufferRenderable {
  sync(text: string, cursor: number): void {
    if (this.plainText !== text) this.setText(text)
    this.cursorOffset = Math.max(0, Math.min(text.length, cursor))
  }
}
const typingCursorStyle = { style: "block", blinking: true } as const
export const cutoutBackground = (renderer: CliRenderer): RGBA => {
  const background: unknown = Reflect.get(renderer, "backgroundColor")
  return background instanceof RGBA && background.a > 0 ? RGBA.defaultBackground(background) : RGBA.defaultBackground()
}
export class SurfaceConstruction extends SurfaceLifecycleCleanup {
  constructor(renderer: CliRenderer, handlers: Handlers, options: SurfaceOptions = {}) {
    super()
    this.renderer = renderer
    this.handlers = handlers
    this.options = options
    this.toolSpinner = new ToolSpinner()
    this.clock = options.clock ?? new SystemClock()
    const monotonicStartedAt = this.clock.now()
    const epochStartedAt = options.epochMillis ?? Effect.runSync(Clock.currentTimeMillis)
    this.currentTimeMillis = options.currentTimeMillis ?? (() => epochStartedAt + this.clock.now() - monotonicStartedAt)
    this.main = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row" })
    this.contentColumn = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "column" })
    this.transcriptRow = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row" })
    const transcriptBackground = cutoutBackground(renderer)
    this.transcriptScroll = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      viewportCulling: true,
      verticalScrollbarOptions: { visible: false },
      rootOptions: { backgroundColor: transcriptBackground },
      wrapperOptions: { backgroundColor: transcriptBackground },
      viewportOptions: { backgroundColor: transcriptBackground },
      contentOptions: {
        flexDirection: "column",
        justifyContent: "flex-end",
        backgroundColor: transcriptBackground,
        paddingTop: spacing.transcript,
        paddingBottom: 0,
        paddingLeft: spacing.transcript,
        paddingRight: spacing.transcript + 1,
      },
      onMouseScroll: (event) => this.handleTranscriptWheel(event),
    })
    this.transcriptScroll.verticalScrollBar.visible = false
    this.transcriptScrollbar = new ScrollBarRenderable(renderer, {
      orientation: "vertical",
      showArrows: false,
      position: "absolute",
      top: 0,
      bottom: 0,
      right: 0,
      width: 1,
      visible: false,
      trackOptions: { foregroundColor: toOpenColor(colors.text), backgroundColor: toOpenColor(colors.muted) },
      onChange: (position) => {
        if (this.scrollbarSyncing || this.destroyed) return
        this.cancelWheelReport()
        this.applyTranscriptPosition(position)
        if (!this.atTranscriptBottom() && isFollowing(this.transcriptViewport.mode))
          this.dispatchTranscriptViewport({ _tag: "DetachCommanded", anchor: this.captureViewportAnchor() })
        this.queueTranscriptScroll(() => this.reportTranscriptScroll())
      },
    })
    this.queueBox = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: toOpenColor(colors.text),
      focusedBorderColor: toOpenColor(colors.text),
      minHeight: 3,
      paddingLeft: spacing.inputHorizontal,
      paddingRight: spacing.inputHorizontal,
      marginLeft: 1,
      marginRight: 1,
      marginBottom: -1,
      flexShrink: 0,
      visible: false,
    })
    this.queueText = new TextRenderable(renderer, { content: "", wrapMode: "word", selectable: false })
    this.queueHint = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      top: 0,
      right: 1,
      zIndex: 10,
      selectable: false,
    })
    this.queueBox.add(this.queueText)
    this.queueBox.add(this.queueHint)
    this.queueLeftJoint = new TextRenderable(renderer, {
      content: "┴",
      position: "absolute",
      left: 1,
      top: 0,
      zIndex: 40,
      fg: toOpenColor(colors.text),
      visible: false,
      selectable: false,
    })
    this.queueRightJoint = new TextRenderable(renderer, {
      content: "┴",
      position: "absolute",
      right: 1,
      top: 0,
      zIndex: 40,
      fg: toOpenColor(colors.text),
      visible: false,
      selectable: false,
    })
    this.inputBox = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: toOpenColor(colors.text),
      focusedBorderColor: toOpenColor(colors.text),
      minHeight: spacing.inputHeight,
      paddingLeft: spacing.inputHorizontal,
      paddingRight: spacing.inputHorizontal,
      flexShrink: 0,
      overflow: "hidden",
    })
    this.input = new TextRenderable(renderer, {
      content: "",
      fg: toOpenColor(colors.text),
      wrapMode: "word",
      visible: false,
    })
    this.composerEditor = new ProjectedEditorRenderable(renderer, {
      height: 1,
      textColor: toOpenColor(colors.text),
      backgroundColor: "transparent",
      selectable: false,
      wrapMode: "word",
      showCursor: true,
      cursorColor: toOpenColor(colors.text),
      cursorStyle: typingCursorStyle,
    })
    this.modeLabel = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      top: 0,
      right: 2,
      zIndex: 30,
      selectable: false,
    })
    this.modeLabel.onMouseDown = (event) => {
      const column = event.x - this.modeLabel.screenX
      if (column >= 0 && column < this.usageLabelWidth) (this.handlers.contextToggle ?? this.handlers.usageToggle)?.()
      else if (column >= this.modeSegmentStart && column < this.modeLabel.width) this.handlers.modeToggle?.()
    }
    const updateUsageHover = (event: MouseEvent) => {
      this.usagePointerX = event.x
      const column = event.x - this.modeLabel.screenX
      const hovered = column >= 0 && column < this.usageLabelWidth
      const modeHovered = column >= this.modeSegmentStart && column < this.modeLabel.width
      if (hovered === this.usageLabelHovered && modeHovered === this.modeLabelHovered) return
      this.usageLabelHovered = hovered
      this.modeLabelHovered = modeHovered
      this.renderer.setMousePointer(hovered || modeHovered ? "pointer" : "default")
      if (this.model !== undefined) this.renderModeLabel(this.model)
      this.renderer.requestRender()
    }
    this.modeLabel.onMouseOver = updateUsageHover
    this.modeLabel.onMouseMove = updateUsageHover
    this.modeLabel.onMouseOut = () => {
      this.usagePointerX = undefined
      if (!this.usageLabelHovered && !this.modeLabelHovered) return
      this.usageLabelHovered = false
      this.modeLabelHovered = false
      this.renderer.setMousePointer("default")
      if (this.model !== undefined) this.renderModeLabel(this.model)
      this.renderer.requestRender()
    }
    this.workspaceLabel = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      bottom: 0,
      right: 2,
      zIndex: 10,
      selectable: false,
    })
    this.statusLabel = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      bottom: 0,
      left: 1,
      zIndex: 30,
      selectable: false,
    })
    this.toastBox = new BoxRenderable(renderer, {
      visible: false,
      position: "absolute",
      top: 1,
      right: 2,
      height: 3,
      zIndex: 40,
      border: true,
      borderStyle: "rounded",
      borderColor: toOpenColor(colors.green),
      focusedBorderColor: toOpenColor(colors.green),
      backgroundColor: toOpenColor(colors.surface),
      paddingLeft: 1,
      paddingRight: 1,
      overflow: "hidden",
    })
    this.toast = new TextRenderable(renderer, { content: "", fg: toOpenColor(colors.text) })
    this.toastBox.add(this.toast)
    this.paletteBox = new BoxRenderable(renderer, {
      visible: false,
      position: "absolute",
      width: 76,
      height: spacing.overlayHeight,
      top: spacing.overlayTop,
      left: 2,
      zIndex: 20,
      border: true,
      borderStyle: "rounded",
      borderColor: toOpenColor(colors.text),
      focusedBorderColor: toOpenColor(colors.text),
      backgroundColor: toOpenColor(colors.surface),
      paddingLeft: 1,
      paddingRight: 1,
      overflow: "hidden",
    })
    this.palette = new TextRenderable(renderer, { content: "", fg: toOpenColor(colors.text), wrapMode: "word" })
    this.contextDividerOne = new TextRenderable(renderer, {
      content: "",
      fg: toOpenColor(colors.muted),
      visible: false,
      position: "absolute",
    })
    this.contextDividerTwo = new TextRenderable(renderer, {
      content: "",
      fg: toOpenColor(colors.muted),
      visible: false,
      position: "absolute",
    })
    this.contextFooter = new TextRenderable(renderer, {
      content: "",
      fg: toOpenColor(colors.muted),
      visible: false,
      position: "absolute",
      wrapMode: "none",
    })
    this.overlayHintOne = new TextRenderable(renderer, {
      content: "",
      visible: false,
      position: "absolute",
      zIndex: 30,
      wrapMode: "none",
    })
    this.overlayHintTwo = new TextRenderable(renderer, {
      content: "",
      visible: false,
      position: "absolute",
      zIndex: 30,
      wrapMode: "none",
    })
    this.overlayEditor = new ProjectedEditorRenderable(renderer, {
      visible: false,
      position: "absolute",
      left: 1,
      top: 0,
      width: 1,
      height: 1,
      zIndex: 1,
      textColor: toOpenColor(colors.text),
      backgroundColor: "transparent",
      selectable: false,
      wrapMode: "none",
      showCursor: true,
      cursorColor: toOpenColor(colors.text),
      cursorStyle: typingCursorStyle,
    })
    this.sidebar = new TextRenderable(renderer, {
      content: "",
      width: boundedThreadSidebarWidth(renderer.terminalWidth),
      flexShrink: 0,
      visible: false,
      fg: toOpenColor(colors.text),
      wrapMode: "none",
      selectable: false,
    })
    this.sidebar.onMouseDown = (event) => {
      if (event.button !== 0) return
      const index = (this.model?.threadSidebar.scrollTop ?? 0) + Math.floor(event.y - this.sidebar.screenY)
      if (index < 0 || index >= (this.model?.threads.length ?? 0)) return
      event.stopPropagation()
      this.handlers.threadSidebarSelect?.(index)
    }
    this.changedFilesBox = new SidebarScrollBoxRenderable(renderer, {
      visible: false,
      width: 34,
      flexShrink: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: toOpenColor(colors.text),
      focusedBorderColor: toOpenColor(colors.text),
      paddingLeft: 1,
      paddingRight: 1,
      scrollY: true,
      viewportCulling: true,
      verticalScrollbarOptions: { marginRight: 1 },
      onMouseScroll: () => this.defer(() => this.refreshSidebarWindow()),
    })
    this.changedFilesBox.onWindowChanged = () => this.refreshSidebarWindow()
    this.changedFilesText = new TextRenderable(renderer, {
      content: "",
      fg: toOpenColor(colors.text),
      selectable: false,
      wrapMode: "none",
    })
    this.changedFilesBox.add(this.changedFilesText)
    this.changedFilesBox.verticalScrollBar.on?.("change", () => {
      this.changedFilesBox.syncVirtualScroll()
      this.refreshSidebarWindow()
    })
    this.changedFilesText.onMouseDown = (event) => {
      if (event.button !== 0) return
      const row = this.sidebarWindowStart + Math.floor(event.y - this.changedFilesText.screenY)
      const file = this.changedRows[row]?.file
      if (file === undefined) return
      event.stopPropagation()
      this.handlers.openPath?.({ path: file.path })
    }
    const updateChangedFilesHover = (event: MouseEvent) => {
      const row = this.sidebarWindowStart + Math.floor(event.y - this.changedFilesText.screenY)
      const hoveredRow = this.changedRows[row]?.file === undefined ? undefined : row
      if (hoveredRow === this.changedFilesHoveredRow) return
      this.changedFilesHoveredRow = hoveredRow
      this.refreshSidebarWindow(true)
      this.renderer.setMousePointer(hoveredRow === undefined ? "default" : "pointer")
      this.renderer.requestRender()
    }
    this.changedFilesText.onMouseOver = updateChangedFilesHover
    this.changedFilesText.onMouseMove = updateChangedFilesHover
    this.changedFilesText.onMouseOut = () => {
      if (this.changedFilesHoveredRow === undefined) return
      this.changedFilesHoveredRow = undefined
      this.refreshSidebarWindow(true)
      this.renderer.setMousePointer("default")
      this.renderer.requestRender()
    }
    this.inputBox.onMouseDown = this.onComposerMouseDown
    this.inputBox.onMouseOver = this.onComposerMouseMove
    this.inputBox.onMouseMove = this.onComposerMouseMove
    this.inputBox.onMouseOut = this.onComposerMouseOut
    renderer.root.onMouseDrag = this.onRootMouseDrag
    renderer.root.onMouseUp = this.onRootMouseUp
    renderer.root.onMouseDragEnd = this.onRootMouseUp
    this.changedFilesBox.onMouseDown = this.onSidebarMouseDown
    this.changedFilesBox.onMouseOver = this.onSidebarMouseMove
    this.changedFilesBox.onMouseMove = this.onSidebarMouseMove
    this.changedFilesBox.onMouseOut = this.onSidebarMouseOut
    this.inputBox.add(this.input)
    this.inputBox.add(this.composerEditor)
    this.paletteBox.add(this.palette)
    this.paletteBox.add(this.contextDividerOne)
    this.paletteBox.add(this.contextDividerTwo)
    this.paletteBox.add(this.contextFooter)
    this.paletteBox.add(this.overlayEditor)
    this.transcriptRow.add(this.transcriptScroll)
    this.transcriptRow.add(this.transcriptScrollbar)
    this.contentColumn.add(this.transcriptRow)
    this.contentColumn.add(this.queueBox)
    this.contentColumn.add(this.inputBox)
    this.contentColumn.add(this.queueLeftJoint)
    this.contentColumn.add(this.queueRightJoint)
    this.main.add(this.sidebar)
    this.main.add(this.contentColumn)
    this.main.add(this.changedFilesBox)
    renderer.root.add(this.main)
    renderer.root.add(this.modeLabel)
    renderer.root.add(this.statusLabel)
    renderer.root.add(this.workspaceLabel)
    renderer.root.add(this.paletteBox)
    renderer.root.add(this.overlayHintOne)
    renderer.root.add(this.overlayHintTwo)
    renderer.root.add(this.toastBox)
    this.paletteBox.onMouseScroll = (event) => {
      if (this.model?.threadSwitcher.open !== true || event.scroll === undefined) return
      event.stopPropagation()
      this.handlers.threadPreviewScroll?.(event.scroll.direction === "up" ? 3 : -3)
    }
    renderer.keyInput.on("keypress", this.onKey)
    renderer.keyInput.on("paste", this.onPaste)
    renderer.on(CliRenderEvents.RESIZE, this.onResize)
    renderer.on(CliRenderEvents.SELECTION, this.onSelection)
    renderer.on(CliRenderEvents.FRAME, this.recordRenderedTranscriptScroll)
  }
}
