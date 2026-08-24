import type {
  BoxRenderable,
  EditBufferRenderable,
  ScrollBarRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  CliRenderer,
  Clock as OpenTuiClock,
} from "@opentui/core"
import { Effect, type Fiber } from "effect"
import type { Key } from "../../presentation/terminal/terminal-keymap"
import type { Model } from "../../state/model/terminal-state"
import type { WelcomeController } from "./opentui-welcome-controller"
import type { GoalController } from "./opentui-goal-controller"
import type { LoaderController } from "./opentui-loader-controller"
import type { HoverController } from "./opentui-hover-controller"
import { PointerController } from "./opentui-pointer-controller"
import type { PathTarget } from "../../presentation/transcript/transcript-tool-detail-types"
import type { TranscriptPane, TranscriptPaneDiagnostics } from "./opentui-transcript-pane"
import type { ThreadBrowser } from "./opentui-thread-browser"
import type { PendingTranscriptPosition, TranscriptRenderableRecord } from "./opentui-surface-transcript-types"
import type { TranscriptViewport, ViewportAnchor } from "../../presentation/transcript/transcript-viewport-state"
import type { ViewportEvent } from "../../presentation/transcript/transcript-viewport-protocol"

export interface Handlers {
  readonly key: (key: Key) => void
  readonly workingFrame?: (frame: string | undefined) => void
  readonly scroll?: (offset: number) => void
  readonly scrollGeometry?: (offset: number) => void
  readonly scrollFollow?: () => void
  readonly paste?: (text: string) => void
  readonly pasteImage?: (image?: { readonly bytes: Uint8Array; readonly mediaType?: string }) => void
  readonly expandPaste?: (token: string) => void
  readonly clickToggle?: (unit: string) => void
  readonly contextToggle?: () => void
  readonly usageToggle?: () => void
  readonly modeToggle?: () => void
  readonly modeCommit?: (selected: number) => void
  readonly modeHover?: (selected: number) => void
  readonly animationTick?: () => void
  readonly composerResize?: (height: number) => void
  readonly sidebarResize?: (width: number) => void
  readonly threadSidebarSelect?: (index: number) => void
  readonly openPath?: (target: PathTarget) => void
  readonly resize: (width: number, height: number) => void
  readonly makeRenderer?: () => Effect.Effect<CliRenderer>
}

export interface SurfaceOptions {
  readonly animate?: boolean
  readonly clock?: OpenTuiClock
  readonly epochMillis?: number
  readonly currentTimeMillis?: () => number
}

const runFork = Effect.runFork

export class SurfaceState {
  protected transcriptPane!: TranscriptPane
  protected threadBrowser!: ThreadBrowser
  public main!: BoxRenderable
  public contentColumn!: BoxRenderable
  public transcriptRow!: BoxRenderable
  public transcriptScroll!: ScrollBoxRenderable
  public transcriptTopSpacer!: BoxRenderable
  public transcriptBottomSpacer!: BoxRenderable
  public transcriptScrollbar!: ScrollBarRenderable
  public input!: TextRenderable
  public composerEditor!: EditBufferRenderable & { sync(text: string, cursor: number): void }
  public inputBox!: BoxRenderable
  public queueBox!: BoxRenderable
  public queueText!: TextRenderable
  public queueHint!: TextRenderable
  public queueLeftJoint!: TextRenderable
  public queueRightJoint!: TextRenderable
  public modeLabel!: TextRenderable
  public workspaceLabel!: TextRenderable
  public paletteBox!: BoxRenderable
  public palette!: TextRenderable
  public contextDividerOne!: TextRenderable
  public contextDividerTwo!: TextRenderable
  public contextFooter!: TextRenderable
  public overlayHintOne!: TextRenderable
  public overlayHintTwo!: TextRenderable
  public overlayEditor!: EditBufferRenderable & { sync(text: string, cursor: number): void }
  public sidebar!: TextRenderable
  public changedFilesBox!: ScrollBoxRenderable & {
    setVirtualHeight(value: number): void
    syncVirtualScroll(): void
    onWindowChanged: (() => void) | undefined
  }
  public changedFilesText!: TextRenderable
  public statusLabel!: TextRenderable
  public goalLabel!: TextRenderable
  public toastBox!: BoxRenderable
  public toast!: TextRenderable
  public ctrlCMenuBox!: BoxRenderable
  public ctrlCMenuTitle!: TextRenderable
  public ctrlCMenu!: TextRenderable
  protected lastPaste: { readonly text: string; readonly at: number } | undefined
  protected welcomeController!: WelcomeController
  protected goalController!: GoalController
  protected loaderController!: LoaderController
  protected hoverController!: HoverController
  protected readonly pointerController = new PointerController()
  protected model: Model | undefined
  protected changedFilesHoveredRow: number | undefined
  protected clock!: OpenTuiClock
  protected currentTimeMillis!: () => number
  protected toolSpinner!: { step(): void; toBraille(): string }
  protected destroyed = false
  protected junkBuffer: Array<Key> = []
  protected junkTimer: Fiber.Fiber<void> | undefined
  protected renderer!: CliRenderer
  protected handlers!: Handlers
  protected options!: SurfaceOptions
  public mountedTranscriptRowCount(): number {
    return this.transcriptPane.mountedRowCount()
  }
  public animationDiagnostics(): {
    readonly loaderRunning: boolean
    readonly welcomeRunning: boolean
    readonly goalRunning: boolean
    readonly loaderPhase: number
    readonly welcomePhase: number
    readonly goalPhase: number
  } {
    return {
      loaderRunning: this.loaderController.running,
      welcomeRunning: this.welcomeController.running,
      goalRunning: this.goalController.running,
      loaderPhase: this.loaderController.phase,
      welcomePhase: this.welcomeController.phase,
      goalPhase: this.goalController.phase,
    }
  }
  public transcriptDiagnostics(): TranscriptPaneDiagnostics {
    return this.transcriptPane.diagnostics()
  }
  public threadPreviewDiagnostics(): ReturnType<ThreadBrowser["diagnostics"]> {
    return this.threadBrowser.diagnostics()
  }
  protected get transcriptChildren(): ReadonlyArray<TextRenderable> {
    return this.transcriptPane.mountedChildren()
  }
  protected get transcriptRecords(): ReadonlyMap<string, TranscriptRenderableRecord> {
    return this.transcriptPane.renderRecords()
  }
  protected get transcriptWindowEnd(): number {
    return this.transcriptPane.windowPosition()
  }
  protected get transcriptViewport(): TranscriptViewport {
    return this.transcriptPane.viewportState()
  }
  protected get transcriptAnchorScrollBy(): number {
    return this.transcriptPane.pendingAnchorOffset()
  }
  protected get pendingTranscriptPosition(): PendingTranscriptPosition | undefined {
    return this.transcriptPane.pendingViewportPosition()
  }
  protected get scrollbarSyncing(): boolean {
    return this.transcriptPane.synchronizingScrollbar()
  }
  protected handleTranscriptScroll(): void {
    this.transcriptPane.observeScroll()
  }
  protected captureViewportAnchor(): ViewportAnchor | undefined {
    return this.transcriptPane.captureVisibleAnchor()
  }
  protected dispatchTranscriptViewport(event: ViewportEvent): void {
    this.transcriptPane.dispatch(event)
  }
  protected syncTranscriptScrollbar(): void {
    this.transcriptPane.synchronizeScrollbar()
  }
  protected cancelTimer(timer: Fiber.Fiber<void> | undefined): void {
    timer?.interruptUnsafe()
  }
  protected defer(action: () => void): void {
    runFork(Effect.yieldNow.pipe(Effect.andThen(Effect.sync(action))))
  }
  protected delayed(duration: number, action: () => void): Fiber.Fiber<void> {
    return runFork(Effect.sleep(duration).pipe(Effect.andThen(Effect.sync(action))))
  }
}
