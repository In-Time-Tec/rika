import {
  BoxRenderable,
  type CliRenderer,
  CliRenderEvents,
  bg,
  bold,
  createCliRenderer,
  decodePasteBytes,
  dim,
  fg,
  type KeyEvent,
  type PasteEvent,
  link,
  RGBA,
  reverse,
  ScrollBoxRenderable,
  StyledText,
  stripAnsiSequences,
  t,
  TextAttributes,
  type TextOptions,
  type TextChunk,
  TextRenderable,
  underline,
} from "@opentui/core"
import { mkdirSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"
import { stdin, stdout } from "node:process"
import { pathToFileURL } from "node:url"
import { Context, Effect, Layer, Queue, Stream } from "effect"
import { DiffRenderCache, type RenderedDiff } from "./diff-renderer"
import * as Keys from "./keys"
import * as Palette from "./palette"
import * as ViewState from "./view-state"

export interface ExitSummary {
  readonly thread_id: string
  readonly workspace_path: string
  readonly title: string
}

export interface OpenFileInput {
  readonly workspace_path: string
  readonly path: string
  readonly range?: ViewState.Card["range"]
}

export interface Adapter {
  readonly render: (state: ViewState.ViewState) => Effect.Effect<void>
  readonly keys: Stream.Stream<Keys.Key>
  readonly actions: Stream.Stream<Action>
  readonly resizes: Stream.Stream<void>
  readonly setExit: (summary: ExitSummary) => Effect.Effect<void>
  readonly openFile: (input: OpenFileInput) => Effect.Effect<void, Error>
  readonly editExternally: (text: string) => Effect.Effect<string>
  readonly pasteImage: (workspacePath: string) => Effect.Effect<string | undefined>
}

export type Action =
  | { readonly _tag: "ToggleCard"; readonly card_id: string }
  | { readonly _tag: "ToggleToolGroup" }
  | { readonly _tag: "OpenFile"; readonly path: string; readonly range?: ViewState.Card["range"] }

export class Service extends Context.Service<Service, Adapter>()("@rika/tui/Renderer") {}

export interface MemoryRenderer {
  readonly rendered: Array<ViewState.ViewState>
  readonly keys?: ReadonlyArray<Keys.Key>
  readonly actions?: ReadonlyArray<Action>
  readonly opened?: Array<OpenFileInput>
}

export const memoryLayer = (memory: MemoryRenderer) =>
  Layer.succeed(
    Service,
    Service.of({
      render: (state: ViewState.ViewState) => Effect.sync(() => memory.rendered.push(state)),
      keys: Stream.fromIterable(memory.keys ?? []),
      actions: Stream.fromIterable(memory.actions ?? []),
      resizes: Stream.empty,
      setExit: () => Effect.void,
      openFile: (input) => Effect.sync(() => memory.opened?.push(input)),
      editExternally: (text: string) => Effect.succeed(text),
      pasteImage: () => Effect.succeed(undefined),
    }),
  )

const color = {
  text: "#c9d1d9",
  dim: "#7d8590",
  faint: "#5c6370",
  border: "#30363d",
  teal: "#2dd4bf",
  orange: "#d2a25c",
  green: "#98c379",
  red: "#e06c75",
  yellow: "#d29922",
  accent: "#58a6ff",
  panel: "#0a0a0a",
  overlayPanel: "#121212",
} as const

const roundedTeeTop = {
  topLeft: "├",
  topRight: "┤",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
  topT: "┬",
  bottomT: "┴",
  leftT: "├",
  rightT: "┤",
  cross: "┼",
} as const

const standaloneCardBodyIndent = 3
const groupedCardBodyIndent = 4

const cutoutBackground = (renderer: CliRenderer): RGBA => {
  const background: unknown = Reflect.get(renderer, "backgroundColor")
  return background instanceof RGBA && background.a > 0 ? RGBA.defaultBackground(background) : RGBA.defaultBackground()
}

const selectableText = (renderer: CliRenderer, options: TextOptions): TextRenderable =>
  new TextRenderable(renderer, { selectionBg: color.accent, selectionFg: color.panel, ...options })

const ansiTeal = (text: string): string => `\x1b[38;2;45;212;191m${text}\x1b[0m`
const ansiDim = (text: string): string => `\x1b[38;2;125;133;144m${text}\x1b[0m`
const ansiBold = (text: string): string => `\x1b[1m${text}\x1b[0m`

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let exitSummary: string | undefined
    const renderer = yield* Effect.acquireRelease(
      Effect.promise(() =>
        createCliRenderer({
          stdin,
          stdout,
          exitOnCtrlC: false,
          screenMode: "alternate-screen",
          useKittyKeyboard: { disambiguate: true, alternateKeys: true },
        }),
      ),
      (instance) =>
        Effect.sync(() => {
          instance.destroy()
          if (exitSummary !== undefined) stdout.write(exitSummary)
        }),
    )

    const actions = yield* Queue.unbounded<Action>()
    const diffRenderer = new DiffRenderCache()
    const surface = new Surface(renderer, actions, diffRenderer)
    yield* Effect.sync(() => bindSelectionCopy(renderer))
    yield* Effect.sync(() => renderer.start())

    return Service.of({
      render: (state: ViewState.ViewState) =>
        Effect.gen(function* () {
          yield* prepareVisibleDiffs(state, diffRenderer)
          yield* Effect.sync(() => {
            try {
              surface.update(state)
              renderer.requestRender()
            } catch {}
          })
        }),
      keys: keyStream(renderer),
      actions: Stream.fromQueue(actions),
      resizes: resizeStream(renderer),
      setExit: (summary: ExitSummary) =>
        Effect.sync(() => {
          exitSummary = renderExitSummary(summary)
        }),
      openFile: (input: OpenFileInput) =>
        Effect.tryPromise({
          try: async () => {
            const absolutePath = resolve(input.workspace_path, input.path)
            const launched = Bun.spawn([...defaultOpenCommand(absolutePath)], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            })
            const exitCode = await launched.exited
            if (exitCode !== 0) throw new Error(`open exited ${exitCode}`)
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
      editExternally: (text: string) =>
        Effect.tryPromise(async () => {
          const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi"
          const file = `${process.env.TMPDIR ?? "/tmp"}/rika-edit-${process.pid}-${Date.now()}.md`
          await Bun.write(file, text)
          renderer.suspend()
          try {
            await Bun.spawn([editor, file], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited
            return (await Bun.file(file).text()).replace(/\n+$/, "")
          } finally {
            renderer.resume()
            try {
              unlinkSync(file)
            } catch {}
          }
        }).pipe(Effect.orElseSucceed(() => text)),
      pasteImage: (workspacePath: string) =>
        Effect.tryPromise(async () => {
          const rel = `.rika/pasted/paste-${Date.now()}.png`
          const abs = `${workspacePath}/${rel}`
          mkdirSync(`${workspacePath}/.rika/pasted`, { recursive: true })
          const script = `try
set theFile to (POSIX file "${abs}")
set pngData to (the clipboard as «class PNGf»)
set fh to open for access theFile with write permission
set eof fh to 0
write pngData to fh
close access fh
end try`
          await Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore" }).exited
          const file = Bun.file(abs)
          if ((await file.exists()) && file.size > 0) return rel
          try {
            unlinkSync(abs)
          } catch {}
          return undefined
        }).pipe(Effect.orElseSucceed(() => undefined)),
    })
  }),
)

const renderExitSummary = (summary: ExitSummary): string => {
  const title = summary.title.length > 0 ? summary.title : "(empty thread)"
  const mark = ["  ·•●•·", " •●●●●•", " •●●●●•", "  ·•●•·"]
  const right = ["", ansiBold(title), ansiDim(summary.workspace_path), ansiDim(`thread ${summary.thread_id}`)]
  const rows = mark.map((line, index) => `${ansiTeal(line)}    ${right[index] ?? ""}`)
  return ["", ...rows, "", ansiDim(`rika --thread ${summary.thread_id}`), ""].join("\n") + "\n"
}

const keyStream = (renderer: CliRenderer): Stream.Stream<Keys.Key> =>
  Stream.callback<Keys.Key>((queue) =>
    Effect.gen(function* () {
      const handler = (key: KeyEvent) => {
        Queue.offerUnsafe(queue, Keys.fromOpenTui(key))
      }
      const pasteHandler = (event: PasteEvent) => {
        const text = stripAnsiSequences(decodePasteBytes(event.bytes))
        if (text.length > 0) Queue.offerUnsafe(queue, Keys.paste(text))
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          renderer.keyInput.on("keypress", handler)
          renderer.keyInput.on("paste", pasteHandler)
        }),
        () =>
          Effect.sync(() => {
            renderer.keyInput.off("keypress", handler)
            renderer.keyInput.off("paste", pasteHandler)
          }),
      )
      yield* Effect.never
    }),
  )

const resizeStream = (renderer: CliRenderer): Stream.Stream<void> =>
  Stream.callback<void>((queue) =>
    Effect.gen(function* () {
      const handler = () => {
        Queue.offerUnsafe(queue, undefined)
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => renderer.on(CliRenderEvents.RESIZE, handler)),
        () => Effect.sync(() => renderer.off(CliRenderEvents.RESIZE, handler)),
      )
      yield* Effect.never
    }),
  )

const bindSelectionCopy = (renderer: CliRenderer): void => {
  renderer.on(CliRenderEvents.SELECTION, (selection) => {
    const text = selection.getSelectedText().trimEnd()
    if (text.length > 0) renderer.copyToClipboardOSC52(text)
  })
}

const prepareVisibleDiffs = (state: ViewState.ViewState, diffRenderer: DiffRenderCache): Effect.Effect<void> =>
  Effect.forEach(expandedDiffs(state), (diff) => diffRenderer.ensure(diff.file_diff), {
    concurrency: 1,
    discard: true,
  })

const expandedDiffs = (
  state: ViewState.ViewState,
): ReadonlyArray<Extract<ViewState.CardContent, { kind: "pierre-diff" }>> =>
  state.cards
    .filter((card) => !ViewState.isCardCollapsed(state, card))
    .map((card) => card.content)
    .filter(
      (content): content is Extract<ViewState.CardContent, { kind: "pierre-diff" }> => content?.kind === "pierre-diff",
    )

export class Surface {
  private readonly transcript: ScrollBoxRenderable
  private readonly entriesBox: BoxRenderable
  private readonly thinkingText: TextRenderable
  private readonly streamingText: TextRenderable
  private readonly queueBox: BoxRenderable
  private readonly queueText: TextRenderable
  private readonly inputBox: BoxRenderable
  private readonly shortcutsText: TextRenderable
  private readonly inputText: TextRenderable
  private readonly statusText: TextRenderable
  private readonly queueHintText: TextRenderable
  private readonly costText: TextRenderable
  private readonly cwdText: TextRenderable
  private readonly paletteBox: BoxRenderable
  private readonly paletteQuery: TextRenderable
  private readonly paletteList: BoxRenderable
  private readonly modePickerBox: BoxRenderable
  private readonly modePickerList: BoxRenderable
  private readonly filePickerBox: BoxRenderable
  private readonly filePickerQuery: TextRenderable
  private readonly filePickerList: BoxRenderable
  private readonly threadSwitcherBox: BoxRenderable
  private readonly threadSwitcherQuery: TextRenderable
  private readonly threadSwitcherBody: BoxRenderable
  private readonly threadSwitcherList: BoxRenderable
  private readonly threadSwitcherPreviewBox: BoxRenderable
  private readonly threadSwitcherPreviewContent: ScrollBoxRenderable
  private readonly threadSwitcherFooter: TextRenderable
  private transcriptSignature = ""

  constructor(
    private readonly renderer: CliRenderer,
    private readonly actions?: Queue.Enqueue<Action>,
    private readonly diffRenderer = new DiffRenderCache(),
  ) {
    const root = renderer.root

    this.transcript = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
      paddingLeft: 1,
      paddingRight: 2,
      paddingTop: 1,
      viewportCulling: true,
      scrollbarOptions: { showArrows: false },
      onMouseMove: () => renderer.setMousePointer("default"),
    })
    this.entriesBox = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0 })
    this.thinkingText = selectableText(renderer, { content: "", marginTop: 1, visible: false })
    this.streamingText = selectableText(renderer, { content: "", marginTop: 1, visible: false })
    this.transcript.add(this.entriesBox)
    this.transcript.add(this.thinkingText)
    this.transcript.add(this.streamingText)
    root.add(this.transcript)

    this.queueBox = new BoxRenderable(renderer, {
      border: ["top", "left", "right"],
      borderStyle: "rounded",
      borderColor: color.text,
      paddingLeft: 1,
      paddingRight: 1,
      flexShrink: 0,
      visible: false,
      minHeight: 2,
    })
    this.queueText = new TextRenderable(renderer, { content: "", selectable: false })
    this.queueHintText = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      top: -1,
      right: 1,
      zIndex: 10,
      visible: false,
      selectable: false,
    })
    this.queueBox.add(this.queueText)
    this.queueBox.add(this.queueHintText)
    root.add(this.queueBox)

    this.inputBox = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: color.text,
      paddingLeft: 1,
      paddingRight: 1,
      flexShrink: 0,
      minHeight: 5,
    })
    this.shortcutsText = new TextRenderable(renderer, { content: "", visible: false, selectable: false })
    this.inputText = new TextRenderable(renderer, { content: "", selectable: false })
    this.inputBox.add(this.shortcutsText)
    this.inputBox.add(this.inputText)
    this.costText = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      top: -1,
      right: 1,
      zIndex: 10,
      selectable: false,
    })
    this.cwdText = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      bottom: -1,
      right: 1,
      zIndex: 10,
      selectable: false,
    })
    this.statusText = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      bottom: -1,
      left: 2,
      zIndex: 10,
      visible: false,
      selectable: false,
    })
    this.inputBox.add(this.costText)
    this.inputBox.add(this.cwdText)
    this.inputBox.add(this.statusText)
    root.add(this.inputBox)

    this.paletteBox = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: "#dedede",
      title: "Command Palette",
      titleColor: "#ffba7b",
      position: "absolute",
      zIndex: 20,
      visible: false,
      backgroundColor: color.overlayPanel,
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
    })
    this.paletteQuery = new TextRenderable(renderer, { content: "", selectable: false })
    this.paletteList = new BoxRenderable(renderer, {
      flexDirection: "column",
      marginTop: 1,
      backgroundColor: color.overlayPanel,
    })
    this.paletteBox.add(this.paletteQuery)
    this.paletteBox.add(this.paletteList)
    root.add(this.paletteBox)

    this.modePickerBox = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: "#dedede",
      position: "absolute",
      zIndex: 20,
      visible: false,
      backgroundColor: color.overlayPanel,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
    })
    this.modePickerList = new BoxRenderable(renderer, {
      flexDirection: "column",
      backgroundColor: color.overlayPanel,
    })
    this.modePickerBox.add(this.modePickerList)
    root.add(this.modePickerBox)

    this.filePickerBox = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: "#dedede",
      title: "Add file",
      titleColor: "#ffba7b",
      position: "absolute",
      zIndex: 20,
      visible: false,
      backgroundColor: color.overlayPanel,
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
    })
    this.filePickerQuery = new TextRenderable(renderer, { content: "", selectable: false })
    this.filePickerList = new BoxRenderable(renderer, {
      flexDirection: "column",
      marginTop: 1,
      backgroundColor: color.overlayPanel,
    })
    this.filePickerBox.add(this.filePickerQuery)
    this.filePickerBox.add(this.filePickerList)
    root.add(this.filePickerBox)

    this.threadSwitcherBox = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: "#dedede",
      title: "Switch Thread",
      titleColor: "#ffba7b",
      position: "absolute",
      zIndex: 30,
      visible: false,
      backgroundColor: color.overlayPanel,
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
    })
    this.threadSwitcherQuery = new TextRenderable(renderer, { content: "", selectable: false })
    this.threadSwitcherBody = new BoxRenderable(renderer, {
      flexDirection: "row",
      marginTop: 1,
      backgroundColor: color.overlayPanel,
    })
    this.threadSwitcherList = new BoxRenderable(renderer, {
      flexDirection: "column",
      backgroundColor: color.overlayPanel,
    })
    this.threadSwitcherPreviewBox = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: "#dedede",
      title: "Thread Preview",
      titleColor: color.text,
      backgroundColor: color.overlayPanel,
      overflow: "hidden",
      marginLeft: 2,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      flexDirection: "column",
    })
    this.threadSwitcherPreviewContent = new ScrollBoxRenderable(renderer, {
      flexDirection: "column",
      backgroundColor: color.overlayPanel,
      flexGrow: 1,
      scrollX: false,
      scrollY: true,
      viewportCulling: true,
      scrollbarOptions: { showArrows: false },
    })
    this.threadSwitcherFooter = new TextRenderable(renderer, {
      content: "",
      marginTop: 1,
      alignSelf: "flex-end",
      selectable: false,
    })
    this.threadSwitcherPreviewBox.add(this.threadSwitcherPreviewContent)
    this.threadSwitcherBody.add(this.threadSwitcherList)
    this.threadSwitcherBody.add(this.threadSwitcherPreviewBox)
    this.threadSwitcherBox.add(this.threadSwitcherQuery)
    this.threadSwitcherBox.add(this.threadSwitcherBody)
    this.threadSwitcherBox.add(this.threadSwitcherFooter)
    root.add(this.threadSwitcherBox)
  }

  update(state: ViewState.ViewState): void {
    const cutoutBg = cutoutBackground(this.renderer)
    this.costText.bg = cutoutBg
    this.cwdText.bg = cutoutBg
    this.statusText.bg = cutoutBg
    this.queueHintText.bg = cutoutBg

    this.costText.top = -1
    this.costText.content = modeIndicatorContent(state)
    this.cwdText.content = t` ${fg(color.dim)(cwdLabel(state))} `

    this.rebuildTranscript(state)

    this.shortcutsText.visible = state.shortcuts_open
    this.shortcutsText.content = state.shortcuts_open ? shortcutsHelp() : ""

    this.queueBox.visible = state.queued.length > 0
    this.queueBox.height = Math.max(2, state.queued.length + 1)
    this.inputBox.customBorderChars = state.queued.length > 0 ? roundedTeeTop : undefined
    this.queueText.content = queueLines(state)
    this.queueHintText.visible = state.queued.length > 0
    this.queueHintText.content = queueHintLine(state)

    this.inputText.content = inputLine(state)

    const status = statusLine(state)
    this.statusText.visible = status !== undefined
    this.statusText.content = status ?? ""

    this.paletteBox.visible = state.palette.open
    if (state.palette.open) {
      const filtered = Palette.filter(state.palette.query, state.mode, state.fast_mode, {
        threadActive: ViewState.hasActivity(state),
        orbBackedThread: ViewState.hasActiveOrb(state),
      })
      const selected = Math.min(state.palette.selected, Math.max(0, filtered.length - 1))
      const width = 80
      const height = Math.min(Math.max(6, filtered.length + 5), Math.max(6, this.renderer.height - 4))
      this.paletteBox.width = width
      this.paletteBox.height = height
      this.paletteBox.left = Math.max(2, Math.floor((this.renderer.width - width) / 2))
      this.paletteBox.top = Math.max(1, Math.floor((this.renderer.height - height) / 2))
      this.paletteQuery.content = t`${fg(color.faint)("> ")}${fg(color.text)(state.palette.query)}${reverse(" ")}`
      const visible = windowList(filtered, selected, Math.max(1, height - 5))
      this.rebuildPaletteList(visible.rows, selected - visible.start, width - 6)
    }

    this.modePickerBox.visible = state.modepicker.open
    if (state.modepicker.open) {
      const width = 58
      const height = ViewState.modePickerFamilies.length + 2
      const inputRows = Math.max(5, ViewState.displayInputText(state.input).split("\n").length + 2)
      this.modePickerBox.width = width
      this.modePickerBox.height = height
      this.modePickerBox.right = 1
      this.modePickerBox.bottom = inputRows + 1
      this.rebuildModePickerList(state, width - 2)
    }

    this.filePickerBox.visible = state.filepicker.open
    if (state.filepicker.open) {
      const files = ViewState.filteredFiles(state)
      const selected = Math.min(state.filepicker.selected, Math.max(0, files.length - 1))
      const width = 80
      const height = Math.min(files.length + 5, Math.max(6, this.renderer.height - 4))
      this.filePickerBox.width = width
      this.filePickerBox.height = height
      this.filePickerBox.left = Math.max(2, Math.floor((this.renderer.width - width) / 2))
      this.filePickerBox.top = Math.max(1, Math.floor((this.renderer.height - height) / 2))
      this.filePickerQuery.content = t`${fg(color.faint)(state.filepicker.kind === "thread" ? "@@" : "@")}${fg(color.text)(state.filepicker.query)}${reverse(" ")}`
      const visible = windowList(files, selected, Math.max(1, height - 5))
      this.rebuildFilePickerList(visible.rows, selected - visible.start, width - 6)
    }

    this.threadSwitcherBox.visible = state.threadswitcher.open
    if (state.threadswitcher.open) {
      const threads = ViewState.filteredThreadSwitcherItems(state)
      const selected = Math.min(state.threadswitcher.selected, Math.max(0, threads.length - 1))
      const width = Math.min(
        Math.max(96, Math.floor(this.renderer.width * 0.74)),
        Math.max(80, this.renderer.width - 24),
      )
      const height = Math.min(
        Math.max(24, Math.floor(this.renderer.height * 0.76)),
        Math.max(16, this.renderer.height - 6),
      )
      const listWidth = Math.max(42, Math.floor((width - 8) * 0.48))
      const previewWidth = Math.max(38, width - listWidth - 8)
      const bodyHeight = Math.max(10, height - 7)
      this.threadSwitcherBox.width = width
      this.threadSwitcherBox.height = height
      this.threadSwitcherBox.left = Math.max(2, Math.floor((this.renderer.width - width) / 2))
      this.threadSwitcherBox.top = Math.max(1, Math.floor((this.renderer.height - height) / 2))
      this.threadSwitcherList.width = listWidth
      this.threadSwitcherList.height = bodyHeight
      this.threadSwitcherPreviewBox.width = previewWidth
      this.threadSwitcherPreviewBox.height = bodyHeight
      this.threadSwitcherPreviewContent.height = Math.max(1, bodyHeight - 4)
      this.threadSwitcherQuery.content = t`${fg(color.text)("> ")}${fg(color.text)(state.threadswitcher.query)}${reverse(" ")}`
      const visible = windowList(threads, selected, Math.max(1, bodyHeight - 1))
      this.rebuildThreadSwitcherList(visible.rows, selected - visible.start, listWidth)
      this.rebuildThreadSwitcherPreview(threads[selected], previewWidth - 6)
      this.threadSwitcherFooter.content = t`${fg(color.accent)("Opt+W/Ctrl+T")} ${fg(color.dim)("all workspaces · Esc close")}`
    }
  }

  private rebuildPaletteList(commands: ReadonlyArray<Palette.Command>, selected: number, width: number): void {
    for (const child of Array.from(this.paletteList.getChildren())) this.paletteList.remove(child.id)
    const catWidth = commands.reduce((max, command) => Math.max(max, command.category.length), 0)
    commands.forEach((command, index) => {
      this.paletteList.add(paletteRow(this.renderer, command, index === selected, catWidth, width))
    })
  }

  private rebuildModePickerList(state: ViewState.ViewState, width: number): void {
    for (const child of Array.from(this.modePickerList.getChildren())) this.modePickerList.remove(child.id)
    modePickerRows.forEach((row, index) => {
      this.modePickerList.add(modePickerRow(this.renderer, state, row, index === state.modepicker.selected, width))
    })
  }

  private rebuildFilePickerList(files: ReadonlyArray<string>, selected: number, width: number): void {
    for (const child of Array.from(this.filePickerList.getChildren())) this.filePickerList.remove(child.id)
    files.forEach((file, index) => {
      if (index === selected) {
        this.filePickerList.add(
          selectableText(this.renderer, {
            content: t`${bold(fg("#0a0a0a")(file.padEnd(width)))}`,
            bg: color.orange,
            width,
            flexShrink: 0,
          }),
        )
      } else {
        this.filePickerList.add(selectableText(this.renderer, { content: t`${fg(color.text)(file)}`, flexShrink: 0 }))
      }
    })
  }

  private rebuildThreadSwitcherList(
    threads: ReadonlyArray<ViewState.ThreadSwitcherItem>,
    selected: number,
    width: number,
  ): void {
    for (const child of Array.from(this.threadSwitcherList.getChildren())) this.threadSwitcherList.remove(child.id)
    if (threads.length === 0) {
      this.threadSwitcherList.add(
        selectableText(this.renderer, {
          content: t`${fg(color.dim)("No matching threads".padEnd(width))}`,
          width,
          flexShrink: 0,
        }),
      )
      return
    }
    threads.forEach((thread, index) => {
      this.threadSwitcherList.add(threadSwitcherRow(this.renderer, thread, index === selected, width))
    })
  }

  private rebuildThreadSwitcherPreview(thread: ViewState.ThreadSwitcherItem | undefined, width: number): void {
    for (const child of Array.from(this.threadSwitcherPreviewContent.getChildren())) {
      this.threadSwitcherPreviewContent.remove(child.id)
    }
    this.threadSwitcherPreviewContent.width = width
    this.threadSwitcherPreviewContent.scrollTo(0)
    for (const block of threadPreviewBlocks(this.renderer, thread, this.diffRenderer, width)) {
      this.threadSwitcherPreviewContent.add(block)
    }
  }

  private rebuildTranscript(state: ViewState.ViewState): void {
    const signature = transcriptSignature(state)
    if (signature !== this.transcriptSignature) {
      this.transcriptSignature = signature
      for (const child of Array.from(this.entriesBox.getChildren())) this.entriesBox.remove(child.id)
      if (isWelcome(state)) {
        this.entriesBox.flexGrow = 1
        this.entriesBox.justifyContent = "center"
        this.entriesBox.alignItems = "stretch"
        this.entriesBox.add(welcomeBlock(this.renderer, state.spinner_index, state.mode))
      } else {
        this.entriesBox.flexGrow = 0
        this.entriesBox.justifyContent = "flex-start"
        this.entriesBox.alignItems = "stretch"
        for (const block of transcriptBlocks(this.renderer, state, {
          variant: "main",
          diffRenderer: this.diffRenderer,
          ...(this.actions === undefined ? {} : { actions: this.actions }),
        })) {
          this.entriesBox.add(block)
        }
      }
    }
    this.updateTrailing(state)
  }

  private updateTrailing(state: ViewState.ViewState): void {
    const thinkingVisible = state.thinking.visible && state.thinking.text.length > 0
    this.thinkingText.visible = thinkingVisible
    this.thinkingText.content = thinkingVisible ? t`${dim("✦ thinking")}\n${fg(color.dim)(state.thinking.text)}` : ""
    const streaming = stripToolCalls(state.streaming_text)
    this.streamingText.visible = streaming.length > 0
    this.streamingText.content = streaming.length > 0 ? renderMarkdown(streaming) : t``
  }
}

type TranscriptRenderable = BoxRenderable | TextRenderable

interface TranscriptRenderOptions {
  readonly variant: "main" | "preview"
  readonly diffRenderer: DiffRenderCache
  readonly actions?: Queue.Enqueue<Action>
}

const transcriptBlocks = (
  renderer: CliRenderer,
  state: ViewState.ViewState,
  options: TranscriptRenderOptions,
): ReadonlyArray<TranscriptRenderable> => {
  const blocks: Array<TranscriptRenderable> = []
  const navId = options.variant === "main" ? ViewState.selectedNavId(state) : undefined
  let toolGroup: Array<ViewState.Card> = []
  const flush = () => {
    if (toolGroup.length === 1) blocks.push(...cardBlocks(renderer, state, toolGroup[0]!, options, 1, false))
    else if (toolGroup.length > 1) blocks.push(...toolGroupBlocks(renderer, state, toolGroup, options))
    toolGroup = []
  }
  for (const entry of state.entries) {
    if (entry.kind === "card" && entry.card.kind === "tool") {
      toolGroup.push(entry.card)
      continue
    }
    flush()
    if (entry.kind === "message") {
      const block = messageBlock(
        renderer,
        state,
        entry.message,
        options.variant === "main" && entry.message.id === navId,
      )
      if (block !== undefined) blocks.push(block)
    } else {
      blocks.push(...cardBlocks(renderer, state, entry.card, options, 1, false))
    }
  }
  flush()
  return blocks
}

const messageBlock = (
  renderer: CliRenderer,
  state: ViewState.ViewState,
  message: ViewState.ThreadMessage,
  selected = false,
): BoxRenderable | TextRenderable | undefined => {
  const displayText = ViewState.messageDisplayText(state, message)
  if (message.role === "user") {
    if (selected) {
      const box = new BoxRenderable(renderer, {
        border: true,
        borderStyle: "rounded",
        borderColor: color.green,
        paddingLeft: 1,
        paddingRight: 1,
        marginTop: 1,
        flexShrink: 0,
        width: "100%",
      })
      const hint = new TextRenderable(renderer, {
        content: t` ${fg(color.accent)("e")}${fg(color.dim)(" to edit")} `,
        position: "absolute",
        bottom: -1,
        left: 2,
        bg: cutoutBackground(renderer),
        selectable: false,
      })
      box.add(selectableText(renderer, { content: t`${fg(color.green)(displayText)}`, selectable: false }))
      box.add(hint)
      return box
    }
    const box = new BoxRenderable(renderer, {
      border: ["left"],
      borderStyle: "heavy",
      borderColor: color.green,
      paddingLeft: 1,
      marginTop: 1,
    })
    box.add(selectableText(renderer, { content: t`${fg(color.green)(displayText)}` }))
    return box
  }
  const text = stripToolCalls(message.text)
  if (text.length === 0) return undefined
  return selectableText(renderer, { content: renderMarkdown(text), marginTop: 1 })
}

const cardBlocks = (
  renderer: CliRenderer,
  state: ViewState.ViewState,
  card: ViewState.Card,
  options: TranscriptRenderOptions,
  marginTop: number,
  grouped: boolean,
): ReadonlyArray<TranscriptRenderable> => {
  const collapsed = ViewState.isCardCollapsed(state, card)
  const expandable = ViewState.isCardExpandable(card)
  const focused = options.variant === "main" && ViewState.focusedCard(state)?.id === card.id
  const frame = ViewState.spinnerFrames[state.spinner_index % ViewState.spinnerFrames.length] ?? "⠋"
  const emit = (action: Action) => emitAction(options.actions, action)
  const openFile = options.variant === "main" ? openFileHandler(card, emit) : undefined
  const row = cardHeaderRow(renderer, {
    card,
    collapsed,
    expandable,
    focused,
    frame,
    workspacePath: state.workspace_path,
    ...(marginTop === 0 ? {} : { marginTop }),
    ...(grouped ? { paddingLeft: 2 } : {}),
    ...(options.variant === "main" && expandable ? { onToggle: emit({ _tag: "ToggleCard", card_id: card.id }) } : {}),
    ...(openFile === undefined ? {} : { onOpenFile: openFile }),
  })
  if (collapsed || card.content === undefined || !ViewState.isCardExpandable(card)) return [row]
  return [
    row,
    selectableText(renderer, {
      content: cardBody(options.diffRenderer, card, grouped ? groupedCardBodyIndent : standaloneCardBodyIndent),
    }),
  ]
}

const toolGroupBlocks = (
  renderer: CliRenderer,
  state: ViewState.ViewState,
  cards: ReadonlyArray<ViewState.Card>,
  options: TranscriptRenderOptions,
): ReadonlyArray<TranscriptRenderable> => {
  const frame = ViewState.spinnerFrames[state.spinner_index % ViewState.spinnerFrames.length] ?? "⠋"
  const anyRunning = cards.some((card) => card.status === "running")
  const anyError = cards.some((card) => card.status === "error")
  const icon = anyRunning ? fg(color.yellow)(frame) : anyError ? fg(color.red)("✕") : fg(color.green)("✓")
  const expanded = state.tool_group_expanded || state.details_expanded
  const blocks: Array<TranscriptRenderable> = [
    new TextRenderable(renderer, {
      content: toolGroupSummaryLine(icon, cards, expanded),
      marginTop: 1,
      ...(options.variant === "main" ? { onMouseDown: emitAction(options.actions, { _tag: "ToggleToolGroup" }) } : {}),
      selectable: false,
    }),
  ]
  if (expanded) {
    for (const card of cards) blocks.push(...cardBlocks(renderer, state, card, options, 0, true))
  }
  return blocks
}

const cardBody = (diffRenderer: DiffRenderCache, card: ViewState.Card, indent: number): StyledText => {
  const content = card.content
  if (content === undefined) return t``
  if (content.kind === "text") return indentedText(content.text, indent, color.dim)
  return diffBody(diffRenderer.render(content.file_diff), indent)
}

const emitAction =
  (actions: Queue.Enqueue<Action> | undefined, action: Action): MouseHandler =>
  (event) => {
    event.stopPropagation()
    event.preventDefault()
    if (actions !== undefined) Queue.offerUnsafe(actions, action)
  }

const toolCategory = (card: ViewState.Card): "file" | "search" | "edit" | "command" => {
  const name = (card.tool_name ?? card.title).toLowerCase()
  if (name === "read" || name.endsWith(".read")) return "file"
  if (name === "write" || name.includes("edit") || name === "apply_patch") return "edit"
  if (name.includes("shell") || name === "bash" || name.includes("command")) return "command"
  return "search"
}

interface ToolGroupSummaryPart {
  readonly label: string
  readonly detail: string
}

const toolGroupSummaryParts = (cards: ReadonlyArray<ViewState.Card>): ReadonlyArray<ToolGroupSummaryPart> => {
  const files = new Set<string>()
  const searches = new Set<string>()
  const edits = new Set<string>()
  let untargetedFiles = 0
  let untargetedSearches = 0
  let untargetedEdits = 0
  let commands = 0
  for (const card of cards) {
    const category = toolCategory(card)
    if (category === "file") {
      if (card.path === undefined) untargetedFiles += 1
      else files.add(card.path)
    } else if (category === "search") {
      searches.add(card.path ?? card.title)
      if (card.path === undefined && card.title.length === 0) untargetedSearches += 1
    } else if (category === "edit") {
      if (card.path === undefined) untargetedEdits += 1
      else edits.add(card.path)
    } else commands += 1
  }
  const fileCount = files.size + untargetedFiles
  const searchCount = searches.size + untargetedSearches
  const editCount = edits.size + untargetedEdits
  const explored: Array<string> = []
  if (fileCount > 0) explored.push(`${fileCount} file${fileCount > 1 ? "s" : ""}`)
  if (searchCount > 0) explored.push(`${searchCount} search${searchCount > 1 ? "es" : ""}`)
  const parts: Array<ToolGroupSummaryPart> = []
  if (commands > 0) parts.push({ label: "Ran", detail: `${commands} command${commands > 1 ? "s" : ""}` })
  if (explored.length > 0) parts.push({ label: "Explored", detail: explored.join(", ") })
  if (editCount > 0) parts.push({ label: "Edited", detail: `${editCount} file${editCount > 1 ? "s" : ""}` })
  return parts
}

const toolGroupSummaryLine = (icon: TextChunk, cards: ReadonlyArray<ViewState.Card>, expanded: boolean): StyledText => {
  const parts = toolGroupSummaryParts(cards)
  const chunks: TextChunk[] = [icon, fg(color.text)(" ")]
  if (parts.length === 0) {
    chunks.push(fg(color.text)("Ran"), fg(color.dim)(` ${cards.length} tools`))
  } else {
    parts.forEach((part, index) => {
      if (index > 0) chunks.push(fg(color.faint)(", "))
      chunks.push(fg(color.text)(part.label), fg(color.dim)(` ${part.detail}`))
    })
  }
  chunks.push(fg(color.faint)(` ${expanded ? "▾" : "▸"}`))
  return new StyledText(chunks)
}

const isWelcome = (state: ViewState.ViewState) =>
  state.entries.length === 0 && state.streaming_text.length === 0 && !state.thinking.visible

const superscripts = ["", "¹", "²", "³"] as const

const modeLabel = (mode: ViewState.ViewState["mode"], effort: number): string =>
  isDeepMode(mode) ? `deep${superscripts[effort] ?? superscripts[1]}` : mode

const hex2 = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0")

const modeRgb = (mode: ViewState.ViewState["mode"]): readonly [number, number, number] =>
  isDeepMode(mode) ? [63, 185, 80] : mode === "rush" ? [210, 162, 92] : [88, 166, 255]

const modeColor = (mode: ViewState.ViewState["mode"]): string => {
  const [r, g, b] = modeRgb(mode)
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`
}

const rgbHex = (rgb: readonly [number, number, number]): string => `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`

const modeLabelChunks = (state: ViewState.ViewState): TextChunk[] => {
  const label = modeLabel(state.mode, state.reasoning_effort)
  if (state.mode_switch_ticks <= 0) return [fg(modeColor(state.mode))(label)]
  const base = modeRgb(state.mode)
  const remaining = state.mode_switch_ticks / ViewState.modeSwitchTicks
  const glowFor = (index: number, chars: number): number => {
    if (state.mode_switch_kind === "tier") return index === chars - 1 ? remaining : 0
    const head = (1 - remaining) * (chars + 2)
    return Math.max(0, 1 - Math.abs(index - head) / 2)
  }
  const chars = Array.from(label)
  return chars.map((ch, index) => fg(rgbHex(mix(base, [255, 255, 255], glowFor(index, chars.length))))(ch))
}

const modeIndicatorContent = (state: ViewState.ViewState): StyledText => {
  const chunks: TextChunk[] = [fg(color.text)(" ")]
  const presence = ViewState.presenceStatusLabel(state)
  if (state.cost_usd > 0) chunks.push(fg(color.dim)(`${costLabel(state.cost_usd)} `), fg(color.faint)("— "))
  if (state.remoteArm.enabled) chunks.push(fg(color.green)("[orb] "), fg(color.faint)("— "))
  if (presence !== undefined) chunks.push(fg(color.green)(`${presence} `), fg(color.faint)("— "))
  if (state.context_usage !== undefined)
    chunks.push(
      fg(contextUsageColor(state.context_usage))(ViewState.contextUsageLabel(state.context_usage)),
      fg(color.faint)(" — "),
    )
  if (state.fast_mode) chunks.push(fg(color.yellow)("↯"))
  for (const chunk of modeLabelChunks(state)) chunks.push(chunk)
  chunks.push(fg(color.text)(" "))
  return new StyledText(chunks)
}

const contextUsageColor = (usage: ViewState.ContextUsage) => {
  if (usage.tone === "danger") return color.red
  if (usage.tone === "warning") return color.yellow
  return color.dim
}

const costLabel = (cost: number): string => `$${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}`

const activityLabel = (state: ViewState.ViewState): string => {
  switch (state.activity) {
    case "thinking": {
      const tokens = liveTokenCount(state)
      return tokens === 0 ? "Thinking" : `Thinking ${tokens} tok`
    }
    case "streaming": {
      const tokens = liveTokenCount(state)
      return tokens === 0 ? "Streaming" : `Streaming ${tokens} tok`
    }
    case "running-tools":
      return "Running tools"
    case "failed":
      return "Failed"
    default:
      return "Waiting"
  }
}

const liveTokenCount = (state: ViewState.ViewState): number =>
  state.generated_text_chars === 0 ? 0 : Math.ceil(state.generated_text_chars / 4)

const statusLine = (state: ViewState.ViewState): StyledText | undefined => {
  if (state.active) {
    const frame = ViewState.spinnerFrames[state.spinner_index % ViewState.spinnerFrames.length] ?? "⠋"
    return t` ${fg(modeColor(state.mode))(frame)} ${fg(color.dim)(activityLabel(state))} `
  }
  if (state.connecting_ticks > 0) {
    const frame = ViewState.spinnerFrames[state.spinner_index % ViewState.spinnerFrames.length] ?? "⠋"
    return t` ${fg(modeColor(state.mode))(frame)} ${fg(color.dim)("Connecting")} `
  }
  if (state.notice !== undefined && state.notice.length > 0) {
    return t` ${fg(color.yellow)("◇")} ${fg(color.dim)(state.notice)} `
  }
  return undefined
}

const cwdLabel = (state: ViewState.ViewState): string => {
  const path = shortenPath(state.workspace_path, 64)
  return state.git_branch !== undefined && state.git_branch.length > 0 ? `${path} (${state.git_branch})` : path
}

const shortenPath = (path: string, max: number): string => {
  const home = process.env.HOME
  const tilde = home !== undefined && path.startsWith(home) ? `~${path.slice(home.length)}` : path
  if (tilde.length <= max) return tilde
  return `…${tilde.slice(tilde.length - max + 1)}`
}

const queueLines = (state: ViewState.ViewState): StyledText => {
  const chunks: Array<TextChunk> = []
  state.queued.forEach((text, index) => {
    chunks.push(index === state.queue_selected ? bold(fg(color.text)(text)) : fg(color.dim)(text))
    if (index < state.queued.length - 1) chunks.push(fg(color.text)("\n"))
  })
  return new StyledText(chunks)
}

const inputLine = (state: ViewState.ViewState): StyledText => {
  const chunks: Array<TextChunk> = []
  for (const chunk of inputBufferChunks(state)) chunks.push(chunk)
  return new StyledText(chunks)
}

const queueHintLine = (state: ViewState.ViewState): StyledText => {
  if (state.queued.length === 0) return t``
  if (state.queue_selected >= 0) {
    return t` ${fg(color.accent)("Enter")}${fg(color.dim)(" to steer · ")}${fg(color.accent)("Backspace")}${fg(color.dim)(" to dequeue")} `
  }
  return t` ${fg(color.accent)("Enter")}${fg(color.dim)(" to steer")} `
}

const inputBufferChunks = (state: ViewState.ViewState): Array<TextChunk> => {
  const text = ViewState.displayInputText(state.input)
  if (text.length === 0) return [cursorBlock(" ")]
  const cursor = Math.max(0, Math.min(displayCursor(state.input), text.length))
  const before = text.slice(0, cursor)
  const at = text[cursor] ?? " "
  const after = text.slice(cursor + 1)
  return [fg(color.text)(before), cursorBlock(at), fg(color.text)(after)]
}

const displayCursor = (input: ViewState.InputBuffer): number => {
  const rawBeforeCursor = input.text.slice(0, input.cursor)
  return ViewState.displayInputText({ ...input, text: rawBeforeCursor, cursor: rawBeforeCursor.length }).length
}

const cursorBlock = (text: string): TextChunk => fg(color.panel)(bg(color.text)(text))

const windowList = <T>(
  items: ReadonlyArray<T>,
  selected: number,
  visible: number,
): { rows: ReadonlyArray<T>; start: number } => {
  if (items.length <= visible) return { rows: items, start: 0 }
  const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), items.length - visible))
  return { rows: items.slice(start, start + visible), start }
}

type MouseHandler = (event: {
  readonly x: number
  readonly y: number
  readonly stopPropagation: () => void
  readonly preventDefault: () => void
}) => void

const openFileHandler = (card: ViewState.Card, emit: (action: Action) => MouseHandler): MouseHandler | undefined =>
  card.path === undefined
    ? undefined
    : emit({ _tag: "OpenFile", path: card.path, ...(card.range === undefined ? {} : { range: card.range }) })

interface HeaderRowInput {
  readonly card: ViewState.Card
  readonly collapsed: boolean
  readonly expandable: boolean
  readonly focused: boolean
  readonly frame: string
  readonly workspacePath: string
  readonly marginTop?: number
  readonly paddingLeft?: number
  readonly onToggle?: MouseHandler
  readonly onOpenFile?: MouseHandler
}

interface HeaderSegment {
  readonly content: StyledText
  readonly onMouseDown?: MouseHandler
  readonly onMouseOver?: MouseHandler
  readonly onMouseOut?: MouseHandler
  readonly pointerTarget?: boolean
}

const cardHeaderRow = (renderer: CliRenderer, input: HeaderRowInput): BoxRenderable => {
  const segments = cardHeaderSegments(renderer, input)
  const pointerTargets: Array<TextRenderable> = []
  const hasPointerTargets = segments.some((segment) => segment.pointerTarget === true)
  const row = new BoxRenderable(renderer, {
    flexDirection: "row",
    flexShrink: 0,
    ...(input.marginTop === undefined ? {} : { marginTop: input.marginTop }),
    ...(input.paddingLeft === undefined ? {} : { paddingLeft: input.paddingLeft }),
    ...(input.onToggle === undefined ? {} : { onMouseDown: input.onToggle }),
    ...(hasPointerTargets
      ? {
          onMouseMove: pointerCursorForTargets(renderer, pointerTargets),
          onMouseOver: pointerCursorForTargets(renderer, pointerTargets),
        }
      : {}),
  })
  for (const segment of segments) {
    const text = new TextRenderable(renderer, {
      content: segment.content,
      flexShrink: 0,
      selectable:
        segment.onMouseDown === undefined && segment.onMouseOver === undefined && segment.onMouseOut === undefined,
      selectionBg: color.accent,
      selectionFg: color.panel,
      ...(segment.onMouseDown === undefined ? {} : { onMouseDown: segment.onMouseDown }),
      ...(segment.onMouseOver === undefined ? {} : { onMouseOver: segment.onMouseOver }),
      ...(segment.onMouseOut === undefined ? {} : { onMouseOut: segment.onMouseOut }),
    })
    if (segment.pointerTarget === true) pointerTargets.push(text)
    row.add(text)
  }
  return row
}

const cardHeaderSegments = (renderer: CliRenderer, input: HeaderRowInput): ReadonlyArray<HeaderSegment> => {
  const { card, collapsed, expandable, focused, frame } = input
  const arrow = expandable ? ` ${collapsed ? "▸" : "▾"}` : ""
  const icon = statusIcon(card, frame)
  const meta = card.subtitle.length === 0 ? "" : card.kind === "tool" ? ` ${card.subtitle}` : ` · ${card.subtitle}`
  const titleColor = focused ? color.accent : color.dim
  return [
    textSegment(icon),
    textSegment(fg(color.text)(" ")),
    ...titleSegments(renderer, input, titleColor),
    textSegment(fg(color.faint)(meta)),
    textSegment(dim(arrow)),
  ]
}

const textSegment = (
  chunk: TextChunk,
  onMouseDown?: MouseHandler,
  onMouseOver?: MouseHandler,
  onMouseOut?: MouseHandler,
  pointerTarget = false,
): HeaderSegment => ({
  content: new StyledText([chunk]),
  ...(onMouseDown === undefined ? {} : { onMouseDown }),
  ...(onMouseOver === undefined ? {} : { onMouseOver }),
  ...(onMouseOut === undefined ? {} : { onMouseOut }),
  ...(pointerTarget ? { pointerTarget } : {}),
})

const titleSegments = (
  renderer: CliRenderer,
  input: HeaderRowInput,
  titleColor: string,
): ReadonlyArray<HeaderSegment> => {
  const match = /^(.*?)( \+\d+)?( -\d+)?$/.exec(input.card.title)
  const base = match?.[1]
  const additions = match?.[2]
  const deletions = match?.[3]
  if (match === null || (additions === undefined && deletions === undefined) || base === undefined) {
    return baseTitleSegments(renderer, input, input.card.title, titleColor)
  }
  return [
    ...baseTitleSegments(renderer, input, base, titleColor),
    ...(additions === undefined ? [] : [textSegment(fg(color.green)(additions))]),
    ...(deletions === undefined ? [] : [textSegment(fg(color.red)(deletions))]),
  ]
}

const baseTitleSegments = (
  renderer: CliRenderer,
  input: HeaderRowInput,
  title: string,
  titleColor: string,
): ReadonlyArray<HeaderSegment> => {
  const path = input.card.path
  if (path !== undefined) {
    const index = title.indexOf(path)
    if (index >= 0) {
      return [
        ...plainTitleSegment(title.slice(0, index), titleColor),
        textSegment(
          link(fileHref(input.workspacePath, path))(underline(fg(color.orange)(path))),
          input.onOpenFile,
          pointerCursor(renderer),
          undefined,
          true,
        ),
        ...plainTitleSegment(title.slice(index + path.length), titleColor),
      ]
    }
  }
  const match = /^(Edited|Wrote|Write|Read) (.+)$/.exec(title)
  if (match === null) return plainTitleSegment(title, titleColor)
  return [...plainTitleSegment(`${match[1]} `, titleColor), textSegment(fg(color.orange)(match[2] ?? ""))]
}

const plainTitleSegment = (text: string, titleColor: string): ReadonlyArray<HeaderSegment> =>
  text.length === 0 ? [] : [textSegment(fg(titleColor)(text))]

const fileHref = (workspacePath: string, path: string): string => pathToFileURL(resolve(workspacePath, path)).href

const pointerCursor =
  (renderer: CliRenderer): MouseHandler =>
  (event) => {
    renderer.setMousePointer("pointer")
    event.stopPropagation()
  }

const pointerCursorForTargets =
  (renderer: CliRenderer, targets: ReadonlyArray<TextRenderable>): MouseHandler =>
  (event) => {
    const pointer = targets.some((target) => containsPoint(target, event.x, event.y))
    renderer.setMousePointer(pointer ? "pointer" : "default")
    if (pointer) event.stopPropagation()
  }

const containsPoint = (target: TextRenderable, x: number, y: number): boolean =>
  x >= target.screenX && x < target.screenX + target.width && y >= target.screenY && y < target.screenY + target.height

const defaultOpenCommand = (absolutePath: string): ReadonlyArray<string> => {
  if (process.platform === "darwin") return ["open", absolutePath]
  if (process.platform === "win32") return ["cmd", "/c", "start", "", absolutePath]
  return ["xdg-open", absolutePath]
}

const indentedText = (text: string, indent: number, textColor: string): StyledText => {
  const chunks: TextChunk[] = []
  text.split("\n").forEach((line, index) => {
    if (index > 0) chunks.push(fg(color.text)("\n"))
    chunks.push(fg(color.text)(" ".repeat(indent)), fg(textColor)(line))
  })
  return new StyledText(chunks)
}

const diffBody = (diff: RenderedDiff, indent: number): StyledText => {
  const chunks: TextChunk[] = []
  const width = diff.rows.reduce((max, row) => (row.kind === "line" ? Math.max(max, String(row.line).length) : max), 1)
  diff.rows.forEach((line, index) => {
    if (index > 0) chunks.push(fg(color.text)("\n"))
    chunks.push(fg(color.text)(" ".repeat(indent)))
    chunks.push(...diffLineChunks(line, width))
  })
  return new StyledText(chunks)
}

const diffLineChunks = (line: RenderedDiff["rows"][number], width: number): Array<TextChunk> => {
  if (line.kind === "separator") return [fg(color.faint)("...")]
  const tokenColor = line.marker === "+" ? color.green : line.marker === "-" ? color.red : undefined
  return [
    fg(color.faint)(String(line.line).padStart(width)),
    fg(color.text)(" "),
    diffMarker(line.marker),
    fg(color.text)(" "),
    ...line.tokens.map((token) => fg(tokenColor ?? token.color ?? color.text)(token.text)),
  ]
}

const diffMarker = (marker: " " | "+" | "-"): TextChunk => {
  if (marker === "+") return fg(color.green)("+")
  if (marker === "-") return fg(color.red)("-")
  return fg(color.faint)(" ")
}

const paletteRow = (
  renderer: CliRenderer,
  command: Palette.Command,
  selected: boolean,
  catWidth: number,
  width: number,
): TextRenderable => {
  const rowIndent = "       "
  const cat = command.category.padStart(catWidth)
  const key = command.key ?? ""
  const actionWidth = Math.max(0, width - rowIndent.length - catWidth - 2 - (key.length > 0 ? key.length + 1 : 0))
  const action = command.action.padEnd(actionWidth)
  if (selected) {
    const selectedText = "#929292"
    return new TextRenderable(renderer, {
      content: t`${fg(selectedText)(rowIndent)}${fg(selectedText)(cat)}  ${fg(selectedText)(action)}${key.length > 0 ? fg(selectedText)(` ${key}`) : fg(selectedText)("")}`,
      bg: "#ffba7b",
      width,
      flexShrink: 0,
      selectable: false,
    })
  }
  return new TextRenderable(renderer, {
    content: t`${fg(color.dim)(rowIndent)}${fg(color.dim)(cat)}  ${fg(color.text)(action)}${key.length > 0 ? fg(color.faint)(` ${key}`) : fg(color.faint)("")}`,
    flexShrink: 0,
    selectable: false,
  })
}

const modePickerRows = [
  { family: "deep", desc: "The most capable coding mode" },
  { family: "rush", desc: "Fast, low-token mode for small tasks" },
  { family: "smart", desc: "Strong intelligence for any task" },
] as const

const modePickerRow = (
  renderer: CliRenderer,
  state: ViewState.ViewState,
  row: (typeof modePickerRows)[number],
  selected: boolean,
  width: number,
): TextRenderable => {
  const rep: ViewState.ViewState["mode"] =
    row.family === "deep" ? ViewState.deepModeForTier(state.deep_tier) : row.family
  const label = row.family === "deep" ? `deep${superscripts[state.deep_tier] ?? ""}` : row.family
  const pointer = selected ? fg(color.accent)("▶ ") : fg(color.faint)("  ")
  const name = fg(modeColor(rep))(label.padEnd(6))
  const desc = selected ? fg(color.text)(row.desc) : fg(color.dim)(row.desc)
  return new TextRenderable(renderer, {
    content: t`${pointer}${name}  ${desc}`,
    width,
    flexShrink: 0,
    selectable: false,
  })
}

const threadSwitcherRow = (
  renderer: CliRenderer,
  thread: ViewState.ThreadSwitcherItem,
  selected: boolean,
  width: number,
): TextRenderable => {
  const stats = threadDiffText(thread.diff)
  const orbStatus = thread.orb_status === undefined ? "" : ` [orb:${thread.orb_status}]`
  const suffix = `${stats.length > 0 ? ` ${stats}` : ""}${orbStatus}${thread.updated_label.length > 0 ? ` ${thread.updated_label}` : ""}${thread.archived ? " [archived]" : ""}`
  const titleWidth = Math.max(8, width - suffix.length)
  const title = truncate(thread.title, titleWidth).padEnd(titleWidth)
  const plain = `${title}${suffix}`.slice(0, width).padEnd(width)
  if (selected)
    return new TextRenderable(renderer, {
      content: t`${bold(fg("#929292")(plain))}`,
      bg: "#ffba7b",
      width,
      flexShrink: 0,
      selectable: false,
    })
  const chunks: TextChunk[] = [fg(color.text)(title)]
  if (thread.diff !== undefined) {
    chunks.push(fg(color.dim)(" "))
    chunks.push(...threadDiffChunks(thread.diff))
  }
  if (thread.orb_status !== undefined) chunks.push(fg(color.dim)(` [orb:${thread.orb_status}]`))
  if (thread.updated_label.length > 0) chunks.push(fg(color.dim)(` ${thread.updated_label}`))
  if (thread.archived) chunks.push(fg(color.dim)(" [archived]"))
  return new TextRenderable(renderer, {
    content: new StyledText(chunks),
    width,
    flexShrink: 0,
    selectable: false,
  })
}

const threadPreviewBlocks = (
  renderer: CliRenderer,
  thread: ViewState.ThreadSwitcherItem | undefined,
  diffRenderer: DiffRenderCache,
  width: number,
): ReadonlyArray<TranscriptRenderable> => {
  if (thread === undefined) return []
  if (thread.preview_state.status === "ready") {
    const blocks = transcriptBlocks(renderer, thread.preview_state.state, { variant: "preview", diffRenderer })
    return blocks.length > 0 ? blocks : [previewFallback(renderer, thread.preview, width)]
  }
  if (thread.preview_state.status === "failed") return [previewFallback(renderer, thread.preview_state.message, width)]
  if (thread.preview_state.status === "loading") return [previewFallback(renderer, "Loading preview...", width)]
  return [previewFallback(renderer, thread.preview, width)]
}

const previewFallback = (renderer: CliRenderer, text: string, width: number): TextRenderable =>
  selectableText(renderer, {
    content: renderMarkdown(truncatePreviewText(text, Math.max(20, width))),
    selectable: false,
  })

const threadDiffText = (diff: ViewState.ThreadDiffStats | undefined): string => {
  if (diff === undefined) return ""
  const parts = [
    diff.additions > 0 ? `+${diff.additions}` : "",
    diff.modifications > 0 ? `~${diff.modifications}` : "",
    diff.deletions > 0 ? `-${diff.deletions}` : "",
  ].filter(Boolean)
  return parts.join(" ")
}

const threadDiffChunks = (diff: ViewState.ThreadDiffStats): Array<TextChunk> => {
  const chunks: TextChunk[] = []
  if (diff.additions > 0) chunks.push(fg(color.green)(`+${diff.additions}`))
  if (diff.modifications > 0) {
    if (chunks.length > 0) chunks.push(fg(color.dim)(" "))
    chunks.push(fg(color.orange)(`~${diff.modifications}`))
  }
  if (diff.deletions > 0) {
    if (chunks.length > 0) chunks.push(fg(color.dim)(" "))
    chunks.push(fg(color.red)(`-${diff.deletions}`))
  }
  return chunks
}

const truncate = (value: string, width: number): string => {
  if (value.length <= width) return value
  if (width <= 3) return value.slice(0, width)
  return `${value.slice(0, width - 3)}...`
}

const wrapText = (value: string, width: number): ReadonlyArray<string> => {
  const words = value.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [""]
  const lines: Array<string> = []
  let line = ""
  for (const word of words) {
    if (line.length === 0) line = word
    else if (line.length + word.length + 1 <= width) line = `${line} ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  lines.push(line)
  return lines
}

const truncatePreviewText = (value: string, width: number): string => wrapText(value, width).slice(0, 28).join("\n")

const statusIcon = (card: ViewState.Card, frame: string): TextChunk => {
  if (card.status === "success") return fg(color.green)("✓")
  if (card.status === "error") return fg(color.red)("✕")
  if (card.status === "running") return fg(color.yellow)(frame)
  return fg(color.dim)(cardGlyph(card))
}

const cardGlyph = (card: ViewState.Card): string => {
  if (card.kind === "tool") return "◆"
  if (card.kind === "diff") return "△"
  if (card.kind === "error") return "✕"
  if (card.kind === "skill") return "✦"
  if (card.kind === "subagent") return "◎"
  if (card.kind === "context") return "◇"
  return "○"
}

const stripToolCalls = (text: string): string => {
  let result = text
  let index = result.indexOf('{"tool_call"')
  while (index !== -1) {
    let depth = 0
    let inString = false
    let escaped = false
    let end = result.length
    for (let i = index; i < result.length; i += 1) {
      const ch = result[i]
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === "\\") {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === "{") depth += 1
      else if (ch === "}") {
        depth -= 1
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    result = `${result.slice(0, index)}${result.slice(end)}`
    index = result.indexOf('{"tool_call"')
  }
  return result.replace(/\n{3,}/g, "\n\n").trim()
}

const renderMarkdown = (text: string): StyledText => {
  const rendered: TextChunk[][] = []
  let inFence = false
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    rendered.push(inFence ? [fg(color.green)(line)] : lineToChunks(line))
  }
  const chunks: TextChunk[] = []
  rendered.forEach((lineChunks, index) => {
    if (index > 0) chunks.push(fg(color.text)("\n"))
    for (const chunk of lineChunks) chunks.push(chunk)
  })
  return new StyledText(chunks)
}

const lineToChunks = (line: string): TextChunk[] => {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line)
  if (heading) return [bold(fg(color.teal)(heading[2] ?? ""))]
  const headingBold = /^\*\*(.+)\*\*:?\s*$/.exec(line)
  if (headingBold) return [bold(fg(color.teal)(line.replace(/\*\*/g, "")))]
  const bullet = /^(\s*)([-*])\s+(.*)$/.exec(line)
  if (bullet) return [fg(color.dim)(`${bullet[1]}- `), ...inlineChunks(bullet[3] ?? "")]
  const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line)
  if (numbered) return [fg(color.dim)(`${numbered[1]}${numbered[2]}. `), ...inlineChunks(numbered[3] ?? "")]
  return inlineChunks(line)
}

const linkChunk = (url: string, text: string): TextChunk => link(url)(underline(fg(color.teal)(text)))

const inlineChunks = (line: string): TextChunk[] => {
  const out: TextChunk[] = []
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)\]]+)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > last) out.push(fg(color.text)(line.slice(last, match.index)))
    if (match[1] !== undefined) out.push(fg(color.orange)(match[1]))
    else if (match[2] !== undefined) out.push(bold(fg(color.text)(match[2])))
    else if (match[3] !== undefined && match[4] !== undefined) out.push(linkChunk(match[4], match[3]))
    else if (match[5] !== undefined) {
      const trailing = /[.,]$/.test(match[5]) ? match[5].slice(-1) : ""
      const url = trailing.length === 0 ? match[5] : match[5].slice(0, -1)
      out.push(linkChunk(url, url))
      if (trailing.length > 0) out.push(fg(color.text)(trailing))
    }
    last = match.index + match[0].length
  }
  if (last < line.length) out.push(fg(color.text)(line.slice(last)))
  if (out.length === 0) out.push(fg(color.text)(line))
  return out
}

export interface RenderedChunk {
  readonly text: string
  readonly url?: string
  readonly underline: boolean
  readonly fg?: ReadonlyArray<number>
}

export const renderMarkdownChunks = (text: string): ReadonlyArray<RenderedChunk> =>
  renderMarkdown(text).chunks.map((chunk) => ({
    text: chunk.text,
    underline: ((chunk.attributes ?? 0) & TextAttributes.UNDERLINE) !== 0,
    ...(chunk.link === undefined ? {} : { url: chunk.link.url }),
    ...(chunk.fg === undefined ? {} : { fg: chunk.fg.toInts().slice(0, 3) }),
  }))

const shortcutsHelp = (): StyledText => {
  const keyColor = "#8fab9c"
  const rows: Array<[string, string, string, string]> = [
    ["Ctrl+O", "command palette", "Ctrl+R", "prompt history"],
    ["Ctrl+V", "paste images", "Shift+Enter", "newline"],
    ["Ctrl+S", "switch modes", "Opt+D", "toggle reasoning effort"],
    ["Ctrl+G", "edit in $EDITOR", "Opt+T", "expand/collapse details"],
    ["@ / @@", "mention files/threads", "Tab/Shift+Tab", "navigate messages"],
    ["?", "toggle this help", "", ""],
  ]
  const chunks: TextChunk[] = []
  rows.forEach((row, index) => {
    if (index > 0) chunks.push(fg(color.text)("\n"))
    chunks.push(fg(keyColor)(pad(row[0], 16)))
    chunks.push(fg(color.dim)(pad(row[1], 28)))
    chunks.push(fg(keyColor)(pad(row[2], 16)))
    chunks.push(fg(color.dim)(row[3]))
  })
  chunks.push(fg(color.text)("\n"))
  return new StyledText(chunks)
}

const pad = (text: string, width: number): string =>
  text.length >= width ? `${text} ` : `${text}${" ".repeat(width - text.length)}`

const welcomeBlock = (renderer: CliRenderer, phase: number, mode: ViewState.ViewState["mode"]): BoxRenderable => {
  const row = new BoxRenderable(renderer, {
    flexDirection: "row",
    alignItems: "center",
  })
  row.add(new BoxRenderable(renderer, { flexGrow: 1, flexShrink: 1 }))
  row.add(selectableText(renderer, { content: orb(phase, mode), flexShrink: 0 }))
  const right = new BoxRenderable(renderer, { flexGrow: 1, flexShrink: 1, flexDirection: "row" })
  right.add(
    selectableText(renderer, {
      marginLeft: 4,
      flexShrink: 0,
      content: t`${fg(welcomeColor(mode))("Welcome to Amp")}\n\n\n${fg(color.text)("ctrl+o")} ${fg(color.dim)("for commands")}\n${fg(color.text)("?")} ${fg(color.dim)("for shortcuts")}`,
    }),
  )
  row.add(right)
  return row
}

const welcomeColor = (mode: ViewState.ViewState["mode"]): string => (isDeepMode(mode) ? "#55d6a6" : modeColor(mode))

const ampOrbFrame = (rows: ReadonlyArray<string>): ReadonlyArray<string> => [
  "                                        ",
  "                                        ",
  "                                        ",
  ...rows.map(shiftOrbRow),
]

const shiftOrbRow = (row: string): string => ` ${row}`.slice(0, 40)

const ampOrbFrames = [
  ampOrbFrame([
    "            •••••••••••••               ",
    "         ••••••••••●●••••••••           ",
    "      •••••●●●●●●●●•••••••••••••        ",
    "    •••••●●●•••••••••••••••••••••       ",
    "   •••••●●•••••••●●●•••••••••••••••     ",
    "  ••••●●•••••●●●•••●●●●●●●••••••••••    ",
    " ••••●●••••●●●•••●●●●●●●●●••••••••••    ",
    " ••••●••••●●•••••••••••••••••••••••••   ",
    "••••••••••●●•••••••••••••••••••••••••   ",
    "••••••••••●●•••••••••••••••••••••••••   ",
    " ••••••••••••••••••••••••••••••••••••   ",
    " •••••••••••••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "   ••••••••••••••••••••••••••••••••     ",
    "    •••••••••••••••••••••••••••••       ",
    "      •••••••••••••••••••••••••         ",
    "         ••••••••••••••••••••           ",
    "             ···········•               ",
  ]),
  ampOrbFrame([
    "             ••••••••••••               ",
    "         ••••••••••••••••••••           ",
    "      ••●●•••••●●●•••••••••••••         ",
    "     ••••●●•●●•••••••••••••••••••       ",
    "   ••••●●●●•••••••••••••••••••••••      ",
    "  •••••••••••●●••••••••••••••••••••     ",
    " •••••●●•••●●•••••●●●●●●●•••••••••••    ",
    " ••••●••••●••••••••●●●●•••••••••••••    ",
    " ••••●••••●••••••••••••••••••••••••••   ",
    " •••••••••●●•••••••••••••••••••••••••   ",
    " •••••••••••••••••••••••••••••••••••    ",
    " •••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   •••••••••••••••••••••••••••••••      ",
    "     ••••••••••••••••••••••••••••       ",
    "      •••••••••••••••••••••••••         ",
    "         •••••••••••••••••••            ",
    "              ·········•                ",
  ]),
  ampOrbFrame([
    "              ••••••••••                ",
    "          ••••••••••••••••••            ",
    "       ●●••••••●●●•••••••••••••         ",
    "     ●●•••••●●•••••••••••••••••••       ",
    "    •••••●●●••••••••••••••••••••••      ",
    "   ••••●●••••••••••••••••••••••••••     ",
    "  ••••●●••••••••••••••••••••••••••••    ",
    " ••••••••••••••••●●●●●●•••••••••••••    ",
    " •••••••••••••••••••••••••••••••••••    ",
    " ••••●••••●●••••••••••••••••••••••••    ",
    " •••••••••••••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "    ••••••••••••••••••••••••••••••      ",
    "     •••••••••••••••••••••••••••        ",
    "       ••••••••••••••••••••••••         ",
    "          ••••••••••••••••••            ",
    "               ·······•                 ",
  ]),
  ampOrbFrame([
    "               ••••••••                 ",
    "          ••●●••••••••••••••            ",
    "       •••••••••••••••••••••••          ",
    "     ••••••●●•••••••••••••••••••        ",
    "    •••••●●•••••••••••••••••••••••      ",
    "   ••••••••••••••••••••••••••••••••     ",
    "  •••••••••••••••••••••••••••••••••     ",
    "  ••••••••••••••●●●●••••••••••••••••    ",
    " •••••••••••••••●●●●••••••••••••••••    ",
    " •••••••••●•••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   ••••••••••••••••••••••••••••••••     ",
    "    ••••••••••••••••••••••••••••••      ",
    "     •••••••••••••••••••••••••••        ",
    "       •••••••••••••••••••••••          ",
    "          ·················             ",
    "                ·····•                  ",
  ]),
  ampOrbFrame([
    "                ••••••                  ",
    "          •••••••••••••••••             ",
    "       •••••••••••••••••••••••          ",
    "     •••••••••••••••••••••••••••        ",
    "    •••••••••••••••••••••••••••••       ",
    "   •••••••••••••••••••••••••••••••      ",
    "  •●●••••••••••••••••••••••••••••••     ",
    "  ••••••••••••●●●•••••••••••••••••••    ",
    " ••••••••••••●●●●●●•••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   •••••••••••••••••••••••••••••••      ",
    "    •••••••••••••••••••••••••••••       ",
    "      ••••••••••••••••••••••••••        ",
    "        ••••••••••••••••••••••          ",
    "          •···············•             ",
    "                 ••••                   ",
  ]),
  ampOrbFrame([
    "                •••••                   ",
    "           ••●●••••••••••••             ",
    "        ••••••••••••••••••••••          ",
    "      ••••••••••••••••••••••••••        ",
    "    •●●••••••••••••••••••••••••••       ",
    "   •••••••••••●●••••••••••••••••••      ",
    "  ••••••••••●●•••••••••••••••••••••     ",
    "  ••••••••••●•••••••••••••••••••••••    ",
    "  ••••••••●●●●●●••••••••••••••••••••    ",
    "  •••••••••●●●●●••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   •••••••••••••••••••••••••••••••      ",
    "    •••••••••••••••••••••••••••••       ",
    "      ••••••••••••••••••••••••••        ",
    "        ••••••••••••••••••••••          ",
    "          •···············•             ",
    "                  ••                    ",
  ]),
  ampOrbFrame([
    "                ••••••                  ",
    "          •••••••••••••••••             ",
    "        •●●•••••••••••••••••••          ",
    "      ••••••••••••••••••••••••••        ",
    "    •••••••••••••••••••••••••••••       ",
    "   ••••••••••••••●●●●•••••••••••••      ",
    "  •••••••••••••●●●•••••••••••••••••     ",
    "  •••••••●••••••••••••••••••••••••••    ",
    "  •••••••●●●●●●•••••••••••••••••••••    ",
    "  •••••••●●●●●••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   •••••••••••••••••••••••••••••••      ",
    "    •••••••••••••••••••••••••••••       ",
    "     •••••••••••••••••••••••••••        ",
    "       •••••••••••••••••••••••          ",
    "          •···············•             ",
    "                 •••                    ",
  ]),
  ampOrbFrame([
    "               ••••••••                 ",
    "          ••••••••••••••••••            ",
    "       •••••••••••••••••••••••          ",
    "     •••••••••••••••••••••••••••        ",
    "    •••••••••••●●●••••••••••••••••      ",
    "   •••••••••●●●••••••••••••••••••••     ",
    "  •••••••••●●●●••••••••••••••••••••     ",
    "  •••••●•••●●●••••••••••••••••••••••    ",
    " ••••••●●●●●●●••••••••••••••••••••••    ",
    " •••••••●●●●●•••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   ••••••••••••••••••••••••••••••••     ",
    "    ••••••••••••••••••••••••••••••      ",
    "     •••••••••••••••••••••••••••        ",
    "       •••••••••••••••••••••••          ",
    "          ·················             ",
    "                ·····•                  ",
  ]),
  ampOrbFrame([
    "              ••••••••••                ",
    "         •••••••••••••••••••            ",
    "       ••••••••••••••••••••••••         ",
    "     ••••••••●●●●••••••••••••••••       ",
    "   •••••••●●●•••••••••••••••••••••      ",
    "  ••••••●●●••••••••••••••••••••••••     ",
    "  ••••••●●●•••••••••••••••••••••••••    ",
    " ••••●•●●●●•••••••••••••••••••••••••    ",
    " ••••●●●●●●●●●••••••••••••••••••••••    ",
    " •••••••●●●•••••••••••••••••••••••••    ",
    " •••••••••••••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   •••••••••••••••••••••••••••••••      ",
    "     ••••••••••••••••••••••••••••       ",
    "       ••••••••••••••••••••••••         ",
    "         •••••••••••••••••••            ",
    "              •·······•                 ",
  ]),
  ampOrbFrame([
    "            •••••••••••••               ",
    "        •••••●●●●●●••••••••••           ",
    "      •••●●●●•••••••••••••••••••        ",
    "    ••●●●●•••••●●••••••••••••••••       ",
    "   ••●●●••••●●●●●••••••••••••••••••     ",
    "  •••●●••••●●●●•••••••••••••••••••••    ",
    " ••●●●•••••●●●●●••••••••••••••••••••    ",
    " ••●●●●●●●●●●••••●●••••••••••••••••••   ",
    " ••••●●●●●●●●••••••••••••••••••••••••   ",
    " •••••••••••●●•••••••••••••••••••••••   ",
    " ••••••••••••••••••••••••••••••••••••   ",
    " •••••••••••••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "   ••••••••••••••••••••••••••••••••     ",
    "    •••••••••••••••••••••••••••••       ",
    "      •••••••••••••••••••••••••         ",
    "         ••••••••••••••••••••           ",
    "             ···········•               ",
  ]),
] as const

const orb = (phase: number, mode: ViewState.ViewState["mode"]): StyledText => {
  const pattern = ampOrbFrames[(phase + 5) % ampOrbFrames.length] ?? ampOrbFrames[0]
  const chunks: TextChunk[] = []
  for (let r = 0; r < pattern.length; r += 1) {
    if (r > 0) chunks.push(fg(color.text)("\n"))
    for (const glyph of pattern[r] ?? "") {
      if (glyph === " ") {
        chunks.push(fg(color.text)(" "))
      } else {
        const [red, green, blue] = orbColor((r - 1) / 17, mode)
        chunks.push(fg(`#${hex2(red)}${hex2(green)}${hex2(blue)}`)(glyph))
      }
    }
  }
  return new StyledText(chunks)
}

const orbColor = (row: number, mode: ViewState.ViewState["mode"]): readonly [number, number, number] => {
  if (!isDeepMode(mode)) return modeRgb(mode)
  const clamped = Math.max(0, Math.min(1, row))
  const top = [92, 225, 152] as const
  const middle = [64, 140, 124] as const
  const bottom = [36, 64, 168] as const
  return clamped < 0.48 ? mix(top, middle, clamped / 0.48) : mix(middle, bottom, (clamped - 0.48) / 0.52)
}

const isDeepMode = (mode: ViewState.ViewState["mode"]) => mode === "deep1" || mode === "deep2" || mode === "deep3"

const mix = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  tValue: number,
): readonly [number, number, number] => {
  const clamped = Math.max(0, Math.min(1, tValue))
  return [a[0] + (b[0] - a[0]) * clamped, a[1] + (b[1] - a[1]) * clamped, a[2] + (b[2] - a[2]) * clamped]
}

const transcriptSignature = (state: ViewState.ViewState): string => {
  const items = state.entries
    .map((entry) =>
      entry.kind === "message"
        ? `m:${entry.message.id}:${entry.message.text.length}`
        : [
            "c",
            entry.card.id,
            entry.card.status,
            ViewState.isCardCollapsed(state, entry.card) ? "c" : "e",
            entry.card.title,
            entry.card.path ?? "",
            entry.card.range === undefined ? "" : `${entry.card.range.start_line}-${entry.card.range.end_line}`,
          ].join(":"),
    )
    .join("|")
  const running = state.entries.some((entry) => entry.kind === "card" && entry.card.status === "running")
  return [
    isWelcome(state) ? `welcome:${state.spinner_index}:${state.mode}` : `active:${running ? state.spinner_index : 0}`,
    items,
    `focus:${state.focus_index ?? -1}`,
    `nav:${state.nav_index}`,
    `tools:${state.tool_group_expanded ? "e" : "c"}`,
  ].join("#")
}
