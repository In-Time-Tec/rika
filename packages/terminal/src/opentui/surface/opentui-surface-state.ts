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
import type { RowWindowState } from "../../presentation/transcript/transcript-row-window-state"
import type { PathTarget } from "../../presentation/transcript/transcript-tool-detail-types"
import type {
  ChangedFileRow,
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
  public overlayEditor!: EditBufferRenderable & { sync(text: string, cursor: number): void }
  public sidebar!: TextRenderable
  public changedFilesBox!: ScrollBoxRenderable & {
    setVirtualHeight(value: number): void
    syncVirtualScroll(): void
    onWindowChanged: (() => void) | undefined
  }
  public changedFilesText!: TextRenderable
  public statusLabel!: TextRenderable
  public toastBox!: BoxRenderable
  public toast!: TextRenderable
  protected welcomeChild: TextRenderable | undefined
  protected welcomeKey = ""
  protected toastTimer: Fiber.Fiber<void> | undefined
  protected usageLabelWidth = 0
  protected modeLabelContentKey: string | undefined
  protected usageLabelHovered = false
  protected modeLabelHovered = false
  protected modeSegmentStart = 0
  protected usagePointerX: number | undefined
  protected usageLayoutFrame: (() => void) | undefined
  protected lastPaste: { readonly text: string; readonly at: number } | undefined
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
  protected composerDrag: { readonly startY: number; readonly startHeight: number } | undefined
  protected sidebarDrag: { readonly startX: number; readonly startWidth: number } | undefined
  protected pointerShape = "default"
  protected changedRows: ReadonlyArray<ChangedFileRow> = []
  protected changedFilesHoveredRow: number | undefined
  protected sidebarRowsSource: unknown
  protected sidebarRowsView: "changed" | "workspace" | undefined
  protected sidebarRowsWidth = 0
  protected sidebarWindowStart = -1
  protected sidebarWindowEnd = -1
  protected sidebarWindowHoveredRow: number | undefined
  protected sidebarLayoutFrame: (() => void) | undefined
  protected scrollProgrammatic = false
  protected wheelTimer: TimerHandle | undefined
  protected transcriptViewport: TranscriptViewport
  protected loaderPhase = 0
  protected loaderTimer: TimerHandle | undefined
  protected publishedWorkingFrame: string | undefined
  protected workingFramePublished = false
  protected clock!: OpenTuiClock
  protected currentTimeMillis!: () => number
  protected toolSpinner!: { step(): void; toBraille(): string }
  protected transcriptViewportRows = 0
  protected renderedTranscriptScrollTop = 0
  protected transcriptWindowEnd = 0
  protected transcriptRowWindow!: RowWindowState
  protected transcriptRowTotal = 0
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
  protected focusedEditor: (EditBufferRenderable & { sync(text: string, cursor: number): void }) | undefined
  protected cursorRestoreFrame: (() => void) | undefined
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
  constructor() {
    this.transcriptViewport = initialViewport
  }
}
