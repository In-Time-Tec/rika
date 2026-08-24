import {
  BoxRenderable,
  ScrollBoxRenderable,
  CliRenderEvents,
  StyledText,
  TextRenderable,
  SystemClock,
  bg,
  bold,
  dim,
  fg,
  type CliRenderer,
  type MouseEvent,
  createCliRenderer,
} from "@opentui/core"
import { Clock, Effect, Clock as EffectClock, Schema } from "effect"
import { boundedThreadSidebarWidth } from "../../state/layout/model"
import { colors, spacing } from "../../presentation/terminal/theme"
import { toOpenColor } from "../rendering/text-adapter"
import { ToolSpinner } from "../rendering/spinner"
import { SurfaceLifecycle } from "./lifecycle"
import { WelcomeController } from "./welcome/controller"
import { GoalController } from "./goal/controller"
import { LoaderController } from "./loader/controller"
import { HoverController } from "./hover/controller"
import type { Handlers, SurfaceOptions } from "./state"
import { ProjectedEditorRenderable } from "./renderables"
import { TranscriptPane } from "./transcript/pane"
import type { TranscriptScrollBoxRenderable } from "./transcript/pane-geometry"
import { ThreadBrowser } from "./thread-browser"

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

const typingCursorStyle = { style: "block", blinking: true } as const
const runSync = Effect.runSync

export class Surface extends SurfaceLifecycle {
  declare public transcriptScroll: TranscriptScrollBoxRenderable
  constructor(renderer: CliRenderer, handlers: Handlers, options: SurfaceOptions = {}) {
    super()
    this.renderer = renderer
    this.handlers = handlers
    this.options = options
    this.toolSpinner = new ToolSpinner()
    this.clock = options.clock ?? new SystemClock()
    this.welcomeController = new WelcomeController({ clock: this.clock, destroyed: () => this.destroyed })
    this.loaderController = new LoaderController({ clock: this.clock })
    this.goalController = new GoalController({ clock: this.clock })
    this.hoverController = new HoverController({ renderer, destroyed: () => this.destroyed })
    const monotonicStartedAt = this.clock.now()
    const epochStartedAt = options.epochMillis ?? runSync(Clock.currentTimeMillis)
    this.currentTimeMillis = options.currentTimeMillis ?? (() => epochStartedAt + this.clock.now() - monotonicStartedAt)
    this.main = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row" })
    this.contentColumn = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "column" })
    this.transcriptRow = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row" })
    this.transcriptPane = new TranscriptPane(renderer, {
      clock: this.clock,
      handlers: {
        scroll: (offset) => this.handlers.scroll?.(offset),
        scrollGeometry: (offset) => this.handlers.scrollGeometry?.(offset),
        scrollFollow: () => this.handlers.scrollFollow?.(),
        clickToggle: (unit) => this.handlers.clickToggle?.(unit),
        openPath: (target) => this.handlers.openPath?.(target),
        clearWelcome: () => this.welcomeController.clear(),
      },
    })
    this.transcriptScroll = this.transcriptPane.scroll
    this.transcriptTopSpacer = this.transcriptPane.topSpacer
    this.transcriptBottomSpacer = this.transcriptPane.bottomSpacer
    this.transcriptScrollbar = this.transcriptPane.scrollbar
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
      if (column >= 0 && column < this.hoverController.usageWidth)
        (this.handlers.contextToggle ?? this.handlers.usageToggle)?.()
      else if (column >= this.hoverController.modeSegmentStart && column < this.modeLabel.width)
        this.handlers.modeToggle?.()
    }
    const updateUsageHover = (event: MouseEvent) => {
      this.hoverController.pointerX = event.x
      const column = event.x - this.modeLabel.screenX
      const hovered = column >= 0 && column < this.hoverController.usageWidth
      const modeHovered = column >= this.hoverController.modeSegmentStart && column < this.modeLabel.width
      if (hovered === this.hoverController.usageHovered && modeHovered === this.hoverController.modeHovered) return
      this.hoverController.usageHovered = hovered
      this.hoverController.modeHovered = modeHovered
      this.renderer.setMousePointer(hovered || modeHovered ? "pointer" : "default")
      if (this.model !== undefined) this.renderModeLabel(this.model)
      this.renderer.requestRender()
    }
    this.modeLabel.onMouseOver = updateUsageHover
    this.modeLabel.onMouseMove = updateUsageHover
    this.modeLabel.onMouseOut = () => {
      this.hoverController.pointerX = undefined
      if (!this.hoverController.usageHovered && !this.hoverController.modeHovered) return
      this.hoverController.usageHovered = false
      this.hoverController.modeHovered = false
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
    this.goalLabel = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      top: 0,
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
    this.ctrlCMenuBox = new BoxRenderable(renderer, {
      visible: false,
      position: "absolute",
      right: 2,
      bottom: spacing.inputHeight + 1,
      width: 33,
      height: 6,
      zIndex: 40,
      border: true,
      borderStyle: "rounded",
      borderColor: toOpenColor(colors.text),
      focusedBorderColor: toOpenColor(colors.text),
      backgroundColor: toOpenColor(colors.surface),
      paddingLeft: 1,
      paddingRight: 1,
      overflow: "hidden",
    })
    this.ctrlCMenuTitle = new TextRenderable(renderer, {
      visible: false,
      position: "absolute",
      top: 0,
      left: 0,
      width: 14,
      height: 1,
      zIndex: 41,
      content: new StyledText([
        bg(toOpenColor(colors.surface))(fg(toOpenColor(colors.text))("─ ")),
        bold(bg(toOpenColor(colors.surface))(fg(toOpenColor(colors.amber))("Ctrl+C"))),
        dim(bg(toOpenColor(colors.surface))(fg(toOpenColor(colors.text))(" then"))),
        bg(toOpenColor(colors.surface))(" "),
      ]),
      selectable: false,
    })
    this.ctrlCMenu = new TextRenderable(renderer, {
      content: new StyledText([
        bold(fg(toOpenColor(colors.blue))("Ctrl+N")),
        fg(toOpenColor(colors.text))(" Archive and new thread\n"),
        bold(fg(toOpenColor(colors.blue))("Ctrl+E")),
        fg(toOpenColor(colors.text))(" Archive and quit\n"),
        bold(fg(toOpenColor(colors.blue))("Ctrl+C")),
        fg(toOpenColor(colors.text))(" Quit\n"),
        fg(toOpenColor(colors.text))("         "),
        bold(fg(toOpenColor(colors.blue))("Esc")),
        dim(fg(toOpenColor(colors.text))(" cancel")),
      ]),
      selectable: false,
    })
    this.ctrlCMenuBox.add(this.ctrlCMenu)
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
    this.threadBrowser = new ThreadBrowser(renderer, this.clock)
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
    this.changedFilesBox.focusable = false
    this.changedFilesBox.verticalScrollBar.focusable = false
    this.changedFilesBox.onWindowChanged = () => this.refreshSidebarWindow()
    this.changedFilesText = new TextRenderable(renderer, {
      content: "",
      fg: toOpenColor(colors.text),
      selectable: false,
      wrapMode: "none",
    })
    this.changedFilesBox.add(this.changedFilesText)
    this.initializeSidebar()
    this.initializeToast()
    this.changedFilesBox.verticalScrollBar.on?.("change", () => {
      this.changedFilesBox.syncVirtualScroll()
      this.refreshSidebarWindow()
    })
    this.changedFilesText.onMouseDown = (event) => {
      if (event.button !== 0) return
      const row = this.sidebarController.windowStart + Math.floor(event.y - this.changedFilesText.screenY)
      const file = this.sidebarController.rows[row]?.file
      if (file === undefined) return
      event.stopPropagation()
      this.handlers.openPath?.({ path: file.path })
    }
    const updateChangedFilesHover = (event: MouseEvent) => {
      const row = this.sidebarController.windowStart + Math.floor(event.y - this.changedFilesText.screenY)
      const hoveredRow = this.sidebarController.rows[row]?.file === undefined ? undefined : row
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
    this.threadBrowser.mount(this.paletteBox)
    this.transcriptPane.mount(this.transcriptRow)
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
    renderer.root.add(this.goalLabel)
    renderer.root.add(this.workspaceLabel)
    renderer.root.add(this.paletteBox)
    renderer.root.add(this.overlayHintOne)
    renderer.root.add(this.overlayHintTwo)
    renderer.root.add(this.toastBox)
    renderer.root.add(this.ctrlCMenuBox)
    renderer.root.add(this.ctrlCMenuTitle)
    renderer.keyInput.on("keypress", this.onKey)
    renderer.keyInput.on("paste", this.onPaste)
    renderer.on(CliRenderEvents.RESIZE, this.onResize)
    renderer.on(CliRenderEvents.SELECTION, this.onSelection)
  }
}

export class AdapterError extends Schema.TaggedError<AdapterError>()("TuiAdapterError", {
  message: Schema.String,
}) {}
const adapterError = (cause: unknown) => AdapterError.make({ message: String(cause) })

export { renderTranscriptStyled } from "../rendering/renderer"
export { probeNativeAsset } from "../rendering/spinner"

export const create = (handlers: Handlers) =>
  (handlers.makeRenderer === undefined
    ? Effect.tryPromise({
        try: () =>
          createCliRenderer({
            screenMode: "alternate-screen",
            exitOnCtrlC: false,
            exitSignals: [],
            useMouse: true,
            enableMouseMovement: true,
          }),
        catch: adapterError,
      })
    : handlers.makeRenderer()).pipe(
    Effect.flatMap((renderer) =>
      Effect.gen(function* () {
        const epochMillis = yield* EffectClock.currentTimeMillis
        return yield* Effect.try({
          try: () => {
            let surface: Surface | undefined
            let released = false
            const releaseTerminal = () => {
              if (released) return
              released = true
              try {
                surface?.destroy()
              } catch {
              } finally {
                try {
                  renderer.destroy()
                } catch {}
              }
            }
            const suspendTerminal = () => {
              if (released) return
              try {
                renderer.suspend()
              } catch (cause) {
                releaseTerminal()
                throw cause
              }
            }
            const resumeTerminal = () => {
              if (released) return
              try {
                renderer.resume()
              } catch (cause) {
                releaseTerminal()
                throw cause
              }
            }
            try {
              renderer.setBackgroundColor("transparent")
              handlers.resize(renderer.terminalWidth, renderer.terminalHeight)
              surface = new Surface(renderer, handlers, { epochMillis })
              return { surface, releaseTerminal, suspendTerminal, resumeTerminal }
            } catch (cause) {
              releaseTerminal()
              throw cause
            }
          },
          catch: adapterError,
        })
      }),
    ),
  )
