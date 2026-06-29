import {
  BoxRenderable,
  type CliRenderer,
  CliRenderEvents,
  bg,
  bold,
  createCliRenderer,
  dim,
  fg,
  type KeyEvent,
  RGBA,
  reverse,
  ScrollBoxRenderable,
  StyledText,
  t,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import { mkdirSync, unlinkSync } from "node:fs"
import { stdin, stdout } from "node:process"
import { Context, Effect, Layer, Queue, Stream } from "effect"
import * as Keys from "./keys"
import * as Palette from "./palette"
import * as ViewState from "./view-state"

export interface ExitSummary {
  readonly thread_id: string
  readonly workspace_path: string
  readonly title: string
}

export interface Adapter {
  readonly render: (state: ViewState.ViewState) => Effect.Effect<void>
  readonly keys: Stream.Stream<Keys.Key>
  readonly actions: Stream.Stream<Action>
  readonly resizes: Stream.Stream<void>
  readonly setExit: (summary: ExitSummary) => Effect.Effect<void>
  readonly editExternally: (text: string) => Effect.Effect<string>
  readonly pasteImage: (workspacePath: string) => Effect.Effect<string | undefined>
}

export type Action = { readonly _tag: "ToggleCard"; readonly card_id: string } | { readonly _tag: "ToggleToolGroup" }

export class Service extends Context.Service<Service, Adapter>()("@rika/tui/Renderer") {}

export interface MemoryRenderer {
  readonly rendered: Array<ViewState.ViewState>
  readonly keys?: ReadonlyArray<Keys.Key>
  readonly actions?: ReadonlyArray<Action>
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
  green: "#3fb950",
  red: "#f85149",
  yellow: "#d29922",
  accent: "#58a6ff",
  panel: "#0a0a0a",
  modalPanel: "#121212",
} as const

const cutoutBackground = (renderer: CliRenderer): RGBA => {
  const background: unknown = Reflect.get(renderer, "backgroundColor")
  return background instanceof RGBA && background.a > 0 ? RGBA.defaultBackground(background) : RGBA.defaultBackground()
}

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
    const surface = new Surface(renderer, actions)
    yield* Effect.sync(() => renderer.start())

    return Service.of({
      render: (state: ViewState.ViewState) =>
        Effect.sync(() => {
          try {
            surface.update(state)
            renderer.requestRender()
          } catch {}
        }),
      keys: keyStream(renderer),
      actions: Stream.fromQueue(actions),
      resizes: resizeStream(renderer),
      setExit: (summary: ExitSummary) =>
        Effect.sync(() => {
          exitSummary = renderExitSummary(summary)
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
      yield* Effect.acquireRelease(
        Effect.sync(() => renderer.keyInput.on("keypress", handler)),
        () => Effect.sync(() => renderer.keyInput.off("keypress", handler)),
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

export class Surface {
  private readonly transcript: ScrollBoxRenderable
  private readonly entriesBox: BoxRenderable
  private readonly thinkingText: TextRenderable
  private readonly streamingText: TextRenderable
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
  private readonly filePickerBox: BoxRenderable
  private readonly filePickerQuery: TextRenderable
  private readonly filePickerList: BoxRenderable
  private transcriptSignature = ""

  constructor(
    private readonly renderer: CliRenderer,
    private readonly actions?: Queue.Enqueue<Action>,
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
    })
    this.entriesBox = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0 })
    this.thinkingText = new TextRenderable(renderer, { content: "", marginTop: 1, visible: false })
    this.streamingText = new TextRenderable(renderer, { content: "", marginTop: 1, visible: false })
    this.transcript.add(this.entriesBox)
    this.transcript.add(this.thinkingText)
    this.transcript.add(this.streamingText)
    root.add(this.transcript)

    this.inputBox = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: color.text,
      paddingLeft: 1,
      paddingRight: 1,
      flexShrink: 0,
      minHeight: 5,
    })
    this.shortcutsText = new TextRenderable(renderer, { content: "", visible: false })
    this.inputText = new TextRenderable(renderer, { content: "" })
    this.inputBox.add(this.shortcutsText)
    this.inputBox.add(this.inputText)
    this.costText = new TextRenderable(renderer, { content: "", position: "absolute", top: -1, right: 1, zIndex: 10 })
    this.cwdText = new TextRenderable(renderer, { content: "", position: "absolute", bottom: -1, right: 1, zIndex: 10 })
    this.statusText = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      bottom: -1,
      left: 2,
      zIndex: 10,
      visible: false,
    })
    this.queueHintText = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      top: -1,
      left: 2,
      zIndex: 10,
      visible: false,
    })
    this.inputBox.add(this.costText)
    this.inputBox.add(this.cwdText)
    this.inputBox.add(this.statusText)
    this.inputBox.add(this.queueHintText)
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
      backgroundColor: color.modalPanel,
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
    })
    this.paletteQuery = new TextRenderable(renderer, { content: "" })
    this.paletteList = new BoxRenderable(renderer, {
      flexDirection: "column",
      marginTop: 1,
      backgroundColor: color.modalPanel,
    })
    this.paletteBox.add(this.paletteQuery)
    this.paletteBox.add(this.paletteList)
    root.add(this.paletteBox)

    this.filePickerBox = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: "#dedede",
      title: "Add file",
      titleColor: "#ffba7b",
      position: "absolute",
      zIndex: 20,
      visible: false,
      backgroundColor: color.modalPanel,
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
    })
    this.filePickerQuery = new TextRenderable(renderer, { content: "" })
    this.filePickerList = new BoxRenderable(renderer, {
      flexDirection: "column",
      marginTop: 1,
      backgroundColor: color.modalPanel,
    })
    this.filePickerBox.add(this.filePickerQuery)
    this.filePickerBox.add(this.filePickerList)
    root.add(this.filePickerBox)
  }

  update(state: ViewState.ViewState): void {
    const cutoutBg = cutoutBackground(this.renderer)
    this.costText.bg = cutoutBg
    this.cwdText.bg = cutoutBg
    this.statusText.bg = cutoutBg
    this.queueHintText.bg = cutoutBg

    this.costText.content =
      state.cost_usd > 0
        ? t` ${fg(color.dim)(`$${state.cost_usd.toFixed(2)} `)}${fg(color.faint)("— ")}${fg(modeColor(state.mode))(modeLabel(state.mode, state.reasoning_effort))}${state.fast_mode ? fg(color.yellow)(" ⚡") : fg(color.faint)("")} `
        : t` ${fg(modeColor(state.mode))(modeLabel(state.mode, state.reasoning_effort))}${state.fast_mode ? fg(color.yellow)(" ⚡") : fg(color.faint)("")} `
    this.cwdText.content = t` ${fg(color.dim)(cwdLabel(state))} `
    this.transcript.verticalScrollbarOptions = { visible: false, showArrows: false }

    this.rebuildTranscript(state)

    this.shortcutsText.visible = state.shortcuts_open
    this.shortcutsText.content = state.shortcuts_open ? shortcutsHelp() : ""

    this.inputText.content = inputLine(state)

    this.queueHintText.visible = state.queue_selected >= 0
    this.queueHintText.content =
      state.queue_selected >= 0 ? t` ${fg(color.accent)("enter to steer · backspace to dequeue")} ` : ""

    const status = statusLine(state)
    this.statusText.visible = status !== undefined
    this.statusText.content = status ?? ""

    this.paletteBox.visible = state.palette.open
    if (state.palette.open) {
      const filtered = Palette.filter(state.palette.query)
      const selected = Math.min(state.palette.selected, Math.max(0, filtered.length - 1))
      const width = 80
      const height = Math.min(filtered.length + 5, Math.max(6, this.renderer.height - 4))
      this.paletteBox.width = width
      this.paletteBox.height = height
      this.paletteBox.left = Math.max(2, Math.floor((this.renderer.width - width) / 2))
      this.paletteBox.top = Math.max(1, Math.floor((this.renderer.height - height) / 2))
      this.paletteQuery.content = t`${fg(color.faint)("> ")}${fg(color.text)(state.palette.query)}${reverse(" ")}`
      const visible = windowList(filtered, selected, Math.max(1, height - 5))
      this.rebuildPaletteList(visible.rows, selected - visible.start, width - 6)
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
  }

  private rebuildPaletteList(commands: ReadonlyArray<Palette.Command>, selected: number, width: number): void {
    for (const child of Array.from(this.paletteList.getChildren())) this.paletteList.remove(child.id)
    const catWidth = commands.reduce((max, command) => Math.max(max, command.category.length), 0)
    commands.forEach((command, index) => {
      this.paletteList.add(paletteRow(this.renderer, command, index === selected, catWidth, width))
    })
  }

  private rebuildFilePickerList(files: ReadonlyArray<string>, selected: number, width: number): void {
    for (const child of Array.from(this.filePickerList.getChildren())) this.filePickerList.remove(child.id)
    files.forEach((file, index) => {
      if (index === selected) {
        this.filePickerList.add(
          new TextRenderable(this.renderer, {
            content: t`${bold(fg("#0a0a0a")(file.padEnd(width)))}`,
            bg: color.orange,
            width,
            flexShrink: 0,
          }),
        )
      } else {
        this.filePickerList.add(
          new TextRenderable(this.renderer, { content: t`${fg(color.text)(file)}`, flexShrink: 0 }),
        )
      }
    })
  }

  private rebuildTranscript(state: ViewState.ViewState): void {
    const signature = transcriptSignature(state)
    if (signature !== this.transcriptSignature) {
      this.transcriptSignature = signature
      for (const child of Array.from(this.entriesBox.getChildren())) this.entriesBox.remove(child.id)
      if (isWelcome(state)) {
        this.entriesBox.add(welcomeBlock(this.renderer, state.spinner_index, state.mode))
      } else {
        const navId = ViewState.selectedNavId(state)
        let toolGroup: Array<ViewState.Card> = []
        const flush = () => {
          if (toolGroup.length === 1) this.addCard(state, toolGroup[0]!)
          else if (toolGroup.length > 1) this.addToolGroup(state, toolGroup)
          toolGroup = []
        }
        for (const entry of state.entries) {
          if (entry.kind === "card" && entry.card.kind === "tool") {
            toolGroup.push(entry.card)
            continue
          }
          flush()
          if (entry.kind === "message") {
            const block = this.messageBlock(entry.message, entry.message.id === navId)
            if (block !== undefined) this.entriesBox.add(block)
          } else {
            this.addCard(state, entry.card)
          }
        }
        flush()
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

  private messageBlock(message: ViewState.ThreadMessage, selected = false): BoxRenderable | TextRenderable | undefined {
    if (message.role === "user") {
      const barColor = selected ? color.accent : color.green
      const box = new BoxRenderable(this.renderer, {
        border: ["left"],
        borderStyle: "heavy",
        borderColor: barColor,
        paddingLeft: 1,
        marginTop: 1,
      })
      const hint = selected ? fg(color.faint)("   e to edit · tab to cycle") : fg(color.faint)("")
      box.add(new TextRenderable(this.renderer, { content: t`${fg(barColor)(message.text)}${hint}` }))
      return box
    }
    const text = stripToolCalls(message.text)
    if (text.length === 0) return undefined
    return new TextRenderable(this.renderer, { content: renderMarkdown(text), marginTop: 1 })
  }

  private addCard(state: ViewState.ViewState, card: ViewState.Card): void {
    const collapsed = ViewState.isCardCollapsed(state, card)
    const expandable = ViewState.isCardExpandable(card)
    const focused = ViewState.focusedCard(state)?.id === card.id
    const frame = ViewState.spinnerFrames[state.spinner_index % ViewState.spinnerFrames.length] ?? "⠋"
    this.entriesBox.add(
      new TextRenderable(this.renderer, {
        content: cardHeader(card, collapsed, expandable, focused, frame),
        marginTop: 1,
        ...(expandable ? { onMouseDown: this.emitAction({ _tag: "ToggleCard", card_id: card.id }) } : {}),
      }),
    )
    if (!collapsed && card.body !== undefined && card.body.length > 0) {
      this.entriesBox.add(
        new TextRenderable(this.renderer, {
          content: t`${fg(color.dim)(card.body)}`,
          paddingLeft: 2,
        }),
      )
    }
  }

  private addToolGroup(state: ViewState.ViewState, cards: ReadonlyArray<ViewState.Card>): void {
    const frame = ViewState.spinnerFrames[state.spinner_index % ViewState.spinnerFrames.length] ?? "⠋"
    const anyRunning = cards.some((card) => card.status === "running")
    const anyError = cards.some((card) => card.status === "error")
    const icon = anyRunning ? fg(color.yellow)(frame) : anyError ? fg(color.red)("✕") : fg(color.green)("✓")
    const expanded = state.tool_group_expanded || state.details_expanded
    this.entriesBox.add(
      new TextRenderable(this.renderer, {
        content: t`${icon} ${fg(color.dim)(toolGroupSummary(cards))} ${dim(expanded ? "▾" : "▸")}`,
        marginTop: 1,
        onMouseDown: this.emitAction({ _tag: "ToggleToolGroup" }),
      }),
    )
    if (expanded) {
      for (const card of cards) {
        const collapsed = ViewState.isCardCollapsed(state, card)
        const expandable = ViewState.isCardExpandable(card)
        this.entriesBox.add(
          new TextRenderable(this.renderer, {
            content: t`${statusIcon(card, frame)} ${fg(color.dim)(card.title)}${card.subtitle.length > 0 ? fg(color.faint)(` ${card.subtitle}`) : fg(color.faint)("")}${expandable ? dim(` ${collapsed ? "▸" : "▾"}`) : fg(color.faint)("")}`,
            paddingLeft: 2,
            ...(expandable ? { onMouseDown: this.emitAction({ _tag: "ToggleCard", card_id: card.id }) } : {}),
          }),
        )
        if (!collapsed && card.body !== undefined && card.body.length > 0) {
          this.entriesBox.add(
            new TextRenderable(this.renderer, {
              content: t`${fg(color.dim)(card.body)}`,
              paddingLeft: 4,
            }),
          )
        }
      }
    }
  }

  private emitAction(action: Action): (event: { stopPropagation: () => void; preventDefault: () => void }) => void {
    return (event) => {
      event.stopPropagation()
      event.preventDefault()
      if (this.actions !== undefined) Queue.offerUnsafe(this.actions, action)
    }
  }
}

const toolCategory = (card: ViewState.Card): "file" | "search" | "edit" | "command" => {
  const name = (card.tool_name ?? card.title).toLowerCase()
  if (name === "read" || name.endsWith(".read")) return "file"
  if (name === "write" || name.includes("edit") || name === "apply_patch") return "edit"
  if (name.includes("shell") || name === "bash" || name.includes("command")) return "command"
  return "search"
}

const toolGroupSummary = (cards: ReadonlyArray<ViewState.Card>): string => {
  let files = 0
  let searches = 0
  let edits = 0
  let commands = 0
  for (const card of cards) {
    const category = toolCategory(card)
    if (category === "file") files += 1
    else if (category === "search") searches += 1
    else if (category === "edit") edits += 1
    else commands += 1
  }
  const explored: Array<string> = []
  if (files > 0) explored.push(`${files} file${files > 1 ? "s" : ""}`)
  if (searches > 0) explored.push(`${searches} search${searches > 1 ? "es" : ""}`)
  const segments: Array<string> = []
  if (commands > 0) segments.push(`Ran ${commands} command${commands > 1 ? "s" : ""}`)
  if (explored.length > 0) segments.push(`Explored ${explored.join(", ")}`)
  if (edits > 0) segments.push(`Edited ${edits} file${edits > 1 ? "s" : ""}`)
  return segments.length > 0 ? segments.join(" · ") : `Ran ${cards.length} tools`
}

const isWelcome = (state: ViewState.ViewState) =>
  state.entries.length === 0 && state.streaming_text.length === 0 && !state.thinking.visible

const superscripts = ["", "¹", "²", "³"] as const

const modeLabel = (mode: ViewState.ViewState["mode"], effort: number): string =>
  mode === "deep" ? `${mode}${superscripts[effort] ?? superscripts[1]}` : mode

const hex2 = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0")

const modeRgb = (mode: ViewState.ViewState["mode"]): readonly [number, number, number] =>
  mode === "deep" ? [63, 185, 80] : mode === "rush" ? [210, 162, 92] : [88, 166, 255]

const modeColor = (mode: ViewState.ViewState["mode"]): string => {
  const [r, g, b] = modeRgb(mode)
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`
}

const activityLabel = (activity: ViewState.Activity): string => {
  switch (activity) {
    case "thinking":
      return "Thinking…"
    case "streaming":
      return "Streaming…"
    case "running-tools":
      return "Running tools…"
    case "failed":
      return "Failed"
    default:
      return "Working…"
  }
}

const statusLine = (state: ViewState.ViewState): StyledText | undefined => {
  if (state.active) {
    const frame = ViewState.spinnerFrames[state.spinner_index % ViewState.spinnerFrames.length] ?? "⠋"
    return t` ${fg(modeColor(state.mode))(frame)} ${fg(color.dim)(activityLabel(state.activity))} `
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

const inputLine = (state: ViewState.ViewState): StyledText => {
  const chunks: Array<TextChunk> = []
  state.queued.forEach((text, index) => {
    chunks.push(index === state.queue_selected ? bold(fg(color.text)(text)) : fg(color.dim)(text))
    chunks.push(fg(color.text)("\n"))
  })
  for (const chunk of inputBufferChunks(state)) chunks.push(chunk)
  return new StyledText(chunks)
}

const inputBufferChunks = (state: ViewState.ViewState): Array<TextChunk> => {
  const text = state.input.text
  if (text.length === 0) return [cursorBlock(" ")]
  const cursor = Math.max(0, Math.min(state.input.cursor, text.length))
  const before = text.slice(0, cursor)
  const at = text[cursor] ?? " "
  const after = text.slice(cursor + 1)
  return [fg(color.text)(before), cursorBlock(at), fg(color.text)(after)]
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

const cardHeader = (
  card: ViewState.Card,
  collapsed: boolean,
  expandable: boolean,
  focused: boolean,
  frame: string,
): StyledText => {
  const arrow = expandable ? ` ${collapsed ? "▸" : "▾"}` : ""
  const icon = statusIcon(card, frame)
  const meta = card.subtitle.length === 0 ? "" : card.kind === "tool" ? ` ${card.subtitle}` : ` · ${card.subtitle}`
  const titleColor = focused ? color.accent : color.dim
  return t`${icon} ${fg(titleColor)(card.title)}${fg(color.faint)(meta)}${dim(arrow)}`
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
    })
  }
  return new TextRenderable(renderer, {
    content: t`${fg(color.dim)(rowIndent)}${fg(color.dim)(cat)}  ${fg(color.text)(action)}${key.length > 0 ? fg(color.faint)(` ${key}`) : fg(color.faint)("")}`,
    flexShrink: 0,
  })
}

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

const inlineChunks = (line: string): TextChunk[] => {
  const out: TextChunk[] = []
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > last) out.push(fg(color.text)(line.slice(last, match.index)))
    if (match[1] !== undefined) out.push(fg(color.orange)(match[1]))
    else if (match[2] !== undefined) out.push(bold(fg(color.text)(match[2])))
    last = match.index + match[0].length
  }
  if (last < line.length) out.push(fg(color.text)(line.slice(last)))
  if (out.length === 0) out.push(fg(color.text)(line))
  return out
}

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
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 4,
    paddingLeft: 3,
  })
  row.add(new TextRenderable(renderer, { content: orb(phase, mode) }))
  row.add(
    new TextRenderable(renderer, {
      content: t`${fg(welcomeColor(mode))("Welcome to Amp")}\n\n\n${fg(color.text)("ctrl+o")} ${fg(color.dim)("for commands")}\n${fg(color.text)("?")} ${fg(color.dim)("for shortcuts")}`,
    }),
  )
  return row
}

const welcomeColor = (mode: ViewState.ViewState["mode"]): string => (mode === "deep" ? "#55d6a6" : modeColor(mode))

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
  if (mode !== "deep") return modeRgb(mode)
  const clamped = Math.max(0, Math.min(1, row))
  const top = [92, 225, 152] as const
  const middle = [64, 140, 124] as const
  const bottom = [36, 64, 168] as const
  return clamped < 0.48 ? mix(top, middle, clamped / 0.48) : mix(middle, bottom, (clamped - 0.48) / 0.52)
}

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
        : `c:${entry.card.id}:${entry.card.status}:${ViewState.isCardCollapsed(state, entry.card) ? "c" : "e"}`,
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
