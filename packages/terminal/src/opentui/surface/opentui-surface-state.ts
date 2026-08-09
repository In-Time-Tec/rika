import type {
  BoxRenderable,
  EditBufferRenderable,
  ScrollBarRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  StyledText,
  CliRenderer,
  TimerHandle,
  Clock as OpenTuiClock,
} from "@opentui/core"
import type { Fiber } from "effect"
import type { Key } from "../../presentation/terminal/terminal-keymap"
import type { Mode, Model } from "../../state/model/terminal-state"
import { initialViewport, type TranscriptViewport } from "../../presentation/transcript/transcript-viewport-state"
import {
  transcriptVirtualIndex,
  virtualRowOfItemPosition,
  type TranscriptVirtualIndex,
} from "../../presentation/transcript/transcript-virtual-index"
import { maxMountedTranscriptEntries } from "../rendering/opentui-render-transcript-window"
import type { WelcomeController } from "./opentui-welcome-controller"
import type { GoalController } from "./opentui-goal-controller"
import type { LoaderController } from "./opentui-loader-controller"
import type { HoverController } from "./opentui-hover-controller"
import { PointerController } from "./opentui-pointer-controller"
import type { PathTarget } from "../../presentation/transcript/transcript-tool-detail-types"
import type {
  PendingTranscriptPosition,
  TranscriptRenderableRecord,
  TranscriptRenderInput,
} from "./opentui-surface-transcript-types"
import type { TranscriptUnitCacheEntry } from "../rendering/opentui-render-transcript-revision"

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
  readonly threadPreviewScroll?: (offset: number) => void
  readonly openPath?: (target: PathTarget) => void
  readonly resize: (width: number, height: number) => void
  readonly makeRenderer?: () => Promise<CliRenderer>
}

export interface SurfaceOptions {
  readonly animate?: boolean
  readonly clock?: OpenTuiClock
  readonly epochMillis?: number
  readonly currentTimeMillis?: () => number
}

export class SurfaceState {
  public main!: BoxRenderable
  public contentColumn!: BoxRenderable
  public transcriptRow!: BoxRenderable
  public transcriptScroll!: ScrollBoxRenderable
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
  protected lastPaste: { readonly text: string; readonly at: number } | undefined
  protected welcomeController!: WelcomeController
  protected goalController!: GoalController
  protected loaderController!: LoaderController
  protected hoverController!: HoverController
  protected readonly pointerController = new PointerController()
  protected model: Model | undefined
  protected transcriptChildren: Array<TextRenderable> = []
  protected transcriptRecords = new Map<string, TranscriptRenderableRecord>()
  protected transcriptUnitCache = new Map<string, TranscriptUnitCacheEntry>()
  protected transcriptRenderInput: TranscriptRenderInput | undefined
  protected threadSwitcherContentCache:
    | {
        readonly threads: Model["threads"]
        readonly preview: Model["threadPreview"]
        readonly query: string
        readonly selected: number
        readonly previewScroll: number
        readonly workspace: string
        readonly mode: Mode
        readonly width: number
        readonly height: number
        readonly minute: number
        readonly content: StyledText
      }
    | undefined
  protected changedFilesHoveredRow: number | undefined
  protected scrollProgrammatic = false
  protected wheelTimer: TimerHandle | undefined
  protected transcriptViewport: TranscriptViewport
  protected clock!: OpenTuiClock
  protected currentTimeMillis!: () => number
  protected toolSpinner!: { step(): void; toBraille(): string }
  protected transcriptViewportRows = 0
  protected renderedTranscriptScrollTop = 0
  protected transcriptWindowEnd = 0
  protected transcriptRowTotal = 0
  protected transcriptVirtualKey: unknown
  protected transcriptVirtualWidth = 0
  protected transcriptVirtualIndex: TranscriptVirtualIndex | undefined
  protected transcriptWindowThread: string | undefined
  protected transcriptPositionFrame: (() => void) | undefined
  protected transcriptScrollbarSyncPending = false
  protected transcriptAnchorScrollBy = 0
  protected transcriptAnchorNearBottom = false
  protected pendingTranscriptPosition: PendingTranscriptPosition | undefined
  protected nextTranscriptPositionToken = 0
  protected scrollbarSyncing = false
  protected scrollGeneration = 0
  protected destroyed = false
  protected junkBuffer: Array<Key> = []
  protected junkTimer: Fiber.Fiber<void> | undefined
  protected renderer!: CliRenderer
  protected handlers!: Handlers
  protected options!: SurfaceOptions
  protected readonly recordRenderedTranscriptScroll = () => {
    this.renderedTranscriptScrollTop = this.transcriptScroll.scrollTop
  }
  public mountedTranscriptRowCount(): number {
    return this.transcriptChildren.length
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
  public transcriptDiagnostics(): {
    readonly rows: ReadonlyArray<TextRenderable>
    readonly keys: ReadonlyArray<string>
    readonly windowEnd: number
    readonly rowTotal: number
    readonly following: boolean
    readonly virtualScrollTop: number
    readonly virtualScrollHeight: number
  } {
    const virtual = this.transcriptVirtualMetrics()
    return {
      rows: [...this.transcriptChildren],
      keys: [...this.transcriptRecords.keys()],
      windowEnd: this.transcriptWindowEnd,
      rowTotal: this.transcriptRowTotal,
      following: this.transcriptViewport.mode._tag === "Following",
      virtualScrollTop: virtual.rowsAbove + this.transcriptScroll.scrollTop,
      virtualScrollHeight: virtual.scrollHeight,
    }
  }
  constructor() {
    this.transcriptViewport = initialViewport
  }
  protected virtualIndex(model: Model): TranscriptVirtualIndex {
    if (this.transcriptVirtualKey !== model.items || this.transcriptVirtualWidth !== model.width) {
      this.transcriptVirtualKey = model.items
      this.transcriptVirtualWidth = model.width
      this.transcriptVirtualIndex = transcriptVirtualIndex(model, model.width)
    }
    return this.transcriptVirtualIndex!
  }
  protected transcriptVirtualMetrics(): {
    readonly scrollHeight: number
    readonly rowsAbove: number
  } {
    const model = this.model
    if (model === undefined) return { scrollHeight: 0, rowsAbove: 0 }
    if (model.items.length <= maxMountedTranscriptEntries)
      return { scrollHeight: this.transcriptScroll.scrollHeight, rowsAbove: 0 }
    const index = this.virtualIndex(model)
    const windowStartItem = Math.max(0, this.transcriptWindowEnd - maxMountedTranscriptEntries)
    return {
      scrollHeight: index.totalRows,
      rowsAbove: virtualRowOfItemPosition(index, windowStartItem),
    }
  }
}
