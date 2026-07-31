import type {
  BoxRenderable,
  EditBufferRenderable,
  ScrollBarRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  StyledText,
  CliRenderer,
  TextChunk,
  TimerHandle,
  Clock as OpenTuiClock,
} from "@opentui/core"
import type { Fiber } from "effect"
import type { Key } from "../../presentation/terminal/terminal-keymap"
import type { Mode, Model, QueueItem, TranscriptItem } from "../../state/model/terminal-state"
import type { PathTarget, TranscriptUnit } from "../../presentation/transcript/terminal-transcript-presentation"
import {
  initialViewport,
  type TranscriptViewport,
  type ViewportAnchor,
} from "../../presentation/transcript/transcript-viewport"
import type { RowWindowState } from "../../presentation/transcript/terminal-transcript-presentation"

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
  readonly usageToggle?: () => void
  readonly modeToggle?: () => void
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

export interface TranscriptRenderableRecord {
  readonly key: string
  revision: string
  readonly renderable: TextRenderable
  spinnerChunk?: number
}

export interface TranscriptRenderableDescriptor {
  readonly key: string
  readonly revision: string
  readonly content: StyledText
  readonly selectable?: boolean
  readonly spinnerChunk?: number
  readonly targets?: ReadonlyArray<PathTarget>
  readonly onMouseDown?: TextRenderable["onMouseDown"]
}

export interface TranscriptAnchor {
  readonly key: string
  readonly screenY: number
}

export type PendingTranscriptPosition =
  | {
      readonly _tag: "Anchor"
      readonly token: number
      readonly anchor: TranscriptAnchor | undefined
      readonly threadId: string | undefined
      readonly scrollHeight: number
      readonly scrollBy: number
      readonly nearBottom: boolean
    }
  | {
      readonly _tag: "Follow"
      readonly token: number
      readonly threadId: string | undefined
    }

export interface TranscriptRenderInput {
  readonly entries: Model["entries"]
  readonly blocks: Model["blocks"]
  readonly items: Model["items"]
  readonly expandedRowKeys: Model["expandedRowKeys"]
  readonly detailSelection: Model["detailSelection"]
  readonly width: number
  readonly windowEnd: number
  readonly rowWindowEnd: number
}

export interface ChangedFileRow {
  readonly chunks: ReadonlyArray<TextChunk>
  readonly file?: import("../../state/model/terminal-state").ChangedFile
  readonly nameIndex?: number
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
  protected welcomePhase = 0
  protected welcomeChild: TextRenderable | undefined
  protected welcomeKey = ""
  protected welcomeTimer: Fiber.Fiber<void> | undefined
  protected welcomeStopTimer: Fiber.Fiber<void> | undefined
  protected toastTimer: Fiber.Fiber<void> | undefined
  protected usageLabelWidth = 0
  protected usageLabelHovered = false
  protected modeLabelHovered = false
  protected modeSegmentStart = 0
  protected usagePointerX: number | undefined
  protected usageLayoutFrame: (() => void) | undefined
  protected lastPaste: { readonly text: string; readonly at: number } | undefined
  protected model: Model | undefined
  protected transcriptChildren: Array<TextRenderable> = []
  protected transcriptRecords = new Map<string, TranscriptRenderableRecord>()
  protected transcriptUnitCache = new Map<string, import("../rendering/opentui-renderer").TranscriptUnitCacheEntry>()
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
  constructor() {
    this.transcriptViewport = initialViewport
  }
}

export type SurfaceModel = Model
export type SurfaceQueueItem = QueueItem
export type SurfaceTranscriptItem = TranscriptItem
export type SurfaceUnit = TranscriptUnit
export type SurfaceViewportAnchor = ViewportAnchor
export type SurfaceMode = Mode
export type SurfaceTextChunk = TextChunk
