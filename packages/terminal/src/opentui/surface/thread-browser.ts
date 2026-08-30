import { BoxRenderable, StyledText, TextRenderable, dim, fg, type CliRenderer, type Clock } from "@opentui/core"
import { colors } from "../../presentation/terminal/theme"
import { projectUnits } from "../../presentation/transcript/projection"
import { selectedThreadMetadata } from "../../state/thread/navigation"
import { initial, type Model } from "../../state/model"
import { toOpenColor } from "../rendering/text-adapter"
import { threadSwitcherListContent, threadSwitcherListWidth } from "./overlay-content"
import { TranscriptPane } from "./transcript/pane"

type ReadyPreview = Extract<Model["threadPreview"], { _tag: "Ready" }>["value"]

export interface ThreadBrowserLayout {
  readonly listWidth: number
}

interface PreviewLayout {
  readonly horizontal: boolean
  readonly listWidth: number
  readonly listHeight: number
  readonly previewWidth: number
  readonly previewHeight: number
}

const previewDocuments = new WeakMap<ReadyPreview, Model>()

const previewDocument = (preview: ReadyPreview, workspace: string, mode: Model["mode"]): Model => {
  const cached = previewDocuments.get(preview)
  if (cached !== undefined) return cached
  let document = projectUnits(initial(workspace, mode), preview.units)
  document = { ...document, currentThreadId: preview.threadId }
  previewDocuments.set(preview, document)
  return document
}

export class ThreadBrowser {
  readonly root: BoxRenderable
  readonly transcript: TranscriptPane
  private readonly list: TextRenderable
  private readonly preview: BoxRenderable
  private readonly status: TextRenderable
  private previewValue: Model["threadPreview"] | undefined
  private previewWidth = 0
  private previewHeight = 0

  constructor(renderer: CliRenderer, clock: Clock) {
    this.root = new BoxRenderable(renderer, {
      visible: false,
      position: "absolute",
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      overflow: "hidden",
    })
    this.root.onMouseScroll = (event) => event.stopPropagation()
    this.list = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      top: 0,
      left: 0,
      wrapMode: "none",
      selectable: false,
    })
    this.preview = new BoxRenderable(renderer, {
      position: "absolute",
      border: true,
      borderStyle: "rounded",
      borderColor: toOpenColor(colors.muted),
      focusedBorderColor: toOpenColor(colors.muted),
      title: " Thread Preview ",
      titleAlignment: "center",
      titleColor: toOpenColor(colors.muted),
      overflow: "hidden",
      backgroundColor: toOpenColor(colors.surface),
    })
    this.status = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      top: 0,
      left: 0,
      wrapMode: "none",
      selectable: false,
      visible: false,
    })
    this.transcript = new TranscriptPane(renderer, { clock })
    this.transcript.mount(this.preview, this.root)
    this.preview.add(this.status)
    this.root.add(this.list)
    this.root.add(this.preview)
  }

  mount(parent: BoxRenderable): void {
    parent.add(this.root)
  }

  private previewLayout(model: Model, width: number, height: number): PreviewLayout {
    const horizontal = model.width >= 120
    const listWidth = threadSwitcherListWidth(model, width)
    const listHeight = horizontal ? height : Math.max(5, Math.min(height - 4, Math.floor(height * 0.42)))
    return {
      horizontal,
      listWidth,
      listHeight,
      previewWidth: horizontal ? Math.max(4, width - listWidth - 2) : width,
      previewHeight: horizontal ? Math.max(4, height - 3) : Math.max(4, height - listHeight - 2),
    }
  }

  private showPreviewStatus(model: Model, previewWidth: number, previewHeight: number): void {
    this.transcript.scrollbar.visible = false
    let label = "No preview"
    if (model.threadPreview._tag === "Loading") label = "Loading preview"
    else if (model.threadPreview._tag === "Failed") label = "Preview unavailable"
    const innerWidth = Math.max(1, previewWidth - 2)
    const clipped = label.slice(0, innerWidth)
    const left = Math.max(0, Math.floor((innerWidth - clipped.length) / 2))
    this.status.content = new StyledText([fg(colors.text)(" ".repeat(left)), dim(fg(colors.text)(clipped))])
    this.status.top = Math.max(0, Math.floor((previewHeight - 3) / 2))
    this.status.width = innerWidth
    this.status.visible = true
  }

  update(model: Model, width: number, height: number, now: number): ThreadBrowserLayout {
    this.root.visible = true
    this.root.width = width
    this.root.height = height
    const { horizontal, listWidth, listHeight, previewWidth, previewHeight } = this.previewLayout(model, width, height)
    this.list.width = listWidth
    this.list.height = listHeight
    this.list.content = threadSwitcherListContent(model, listWidth, listHeight, now)
    this.preview.left = horizontal ? listWidth + 2 : 0
    this.preview.top = horizontal ? 1 : listHeight
    this.preview.width = previewWidth
    this.preview.height = previewHeight
    this.transcript.scrollbar.left = this.preview.left + previewWidth - 2
    this.transcript.scrollbar.right = undefined
    this.transcript.scrollbar.top = this.preview.top + 1
    this.transcript.scrollbar.bottom = undefined
    this.transcript.scrollbar.height = previewHeight - 2
    const transcriptWidth = Math.max(1, previewWidth - 2)
    const transcriptHeight = Math.max(1, previewHeight - 2)
    this.transcript.setViewportRows(transcriptHeight)
    const selected = selectedThreadMetadata(model)
    const ready =
      model.threadPreview._tag === "Ready" && model.threadPreview.value.threadId === selected?.id
        ? model.threadPreview.value
        : undefined
    const showTranscript = ready !== undefined && ready.units.length > 0
    this.transcript.scroll.visible = showTranscript
    if (
      ready !== undefined &&
      (this.previewValue !== model.threadPreview ||
        this.previewWidth !== transcriptWidth ||
        this.previewHeight !== transcriptHeight)
    ) {
      const document = previewDocument(ready, model.workspace, model.mode)
      this.transcript.update({ ...document, width: transcriptWidth, height: transcriptHeight })
    }
    this.previewValue = model.threadPreview
    this.previewWidth = transcriptWidth
    this.previewHeight = transcriptHeight
    if (showTranscript) {
      this.status.visible = false
      return { listWidth }
    }
    this.showPreviewStatus(model, previewWidth, previewHeight)
    return { listWidth }
  }

  hide(): void {
    this.root.visible = false
  }

  pageUp(): void {
    this.transcript.pageUp()
  }

  pageDown(): void {
    this.transcript.pageDown()
  }

  home(): void {
    this.transcript.home()
  }

  end(): void {
    this.transcript.end()
  }

  diagnostics() {
    const transcript = this.transcript.diagnostics()
    return {
      scrollTop: this.transcript.scroll.scrollTop,
      scrollHeight: this.transcript.scroll.scrollHeight,
      viewportHeight: this.transcript.scroll.viewport.height,
      scrollbarPosition: this.transcript.scrollbar.scrollPosition,
      scrollbarSize: this.transcript.scrollbar.scrollSize,
      scrollbarViewportSize: this.transcript.scrollbar.viewportSize,
      following: transcript.following,
      rows: transcript.rows,
      bounds: {
        x: this.transcript.scroll.screenX,
        y: this.transcript.scroll.screenY,
        width: this.transcript.scroll.width,
        height: this.transcript.scroll.height,
      },
    }
  }

  destroy(): void {
    this.transcript.destroy()
  }
}
