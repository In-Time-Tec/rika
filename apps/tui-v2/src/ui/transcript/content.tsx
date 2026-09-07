import { Function } from "effect"
import type { ColorInput } from "@opentui/core"
import { Show, createMemo, type Accessor } from "solid-js"
import { renderDiffStyled, renderPierreDiff, renderReadFile } from "@rika/terminal/terminal-diff-presentation"
import { renderMarkdownStyled } from "@rika/terminal/terminal-markdown-presentation"
import type { Activity, TranscriptItem } from "../../client/model"
import { StyledBlock } from "../styled"
import { colors } from "../theme"
import { aggregateActivity, firstPath, isActive, plural, type ToolPresentation } from "./presenter"

const spinnerFrames = ["⠭", "⠿", "⠶", "⠦"] as const

export const statusGlyph: {
  (status: Activity | undefined, frame: number, animate: boolean): string
  (frame: number, animate: boolean): (status: Activity | undefined) => string
} = Function.dual(3, (status: Activity | undefined, frame: number, animate: boolean): string => {
  if (status === "working" || status === "waiting")
    return animate ? spinnerFrames[frame % spinnerFrames.length]! : spinnerFrames[0]
  if (status === "failed") return "✕"
  if (status === "cancelled") return "⊘"
  return "✓"
})

export const statusColor = (status: Activity | undefined): ColorInput => {
  if (status === "working" || status === "waiting") return colors.blue
  if (status === "failed") return colors.red
  if (status === "cancelled") return colors.amber
  if (status === "idle") return colors.green
  return colors.muted
}

export const titleFor = (item: TranscriptItem): string => {
  if (item.title.length > 0) return item.title
  switch (item.kind) {
    case "user":
      return "You"
    case "assistant":
      return "Rika"
    case "reasoning":
      return "Reasoning"
    case "tool":
      return "Tool"
    case "diff":
      return "Changes"
    case "child":
      return "Child run"
    case "notice":
      return "Notice"
    case "error":
      return "Error"
    case "image":
      return "Image attachment"
  }
}

export const MarkdownBody = (props: { readonly source: Accessor<string> }) => (
  <StyledBlock render={(width) => renderMarkdownStyled(props.source(), width)} />
)

export const PlainBody = (props: {
  readonly source: Accessor<string>
  readonly fg?: ColorInput
  readonly attributes?: number
  readonly wrapMode?: "word" | "char" | "none"
  readonly selectable?: boolean
}) => {
  const content = createMemo(() => props.source())
  return (
    <text
      width="100%"
      content={content()}
      fg={props.fg ?? colors.text}
      attributes={props.attributes ?? 0}
      selectable={props.selectable ?? true}
      selectionBg={colors.selectionBg}
      selectionFg={colors.selectionFg}
      wrapMode={props.wrapMode ?? "word"}
    />
  )
}

export const StyledBody = (props: {
  readonly source: Accessor<string>
  readonly path?: string | undefined
  readonly kind: "diff" | "read"
  readonly indent?: number
}) => (
  <StyledBlock
    render={(width) => {
      const source = props.source()
      const indent = props.indent ?? 2
      if (props.kind === "read") {
        return renderReadFile(source, {
          path: props.path,
          width,
          indent: " ".repeat(indent),
        })
      }
      return renderPierreDiff(source, { width, indent }) ?? renderDiffStyled(source, { width, indent })
    }}
  />
)

interface HeaderProps {
  readonly item: Accessor<TranscriptItem>
  readonly status?: Accessor<Activity | undefined>
  readonly frame: Accessor<number>
  readonly animate: Accessor<boolean>
  readonly selected?: Accessor<boolean>
  readonly expanded?: Accessor<boolean>
  readonly onToggle?: () => void
  readonly tone?: ColorInput
  readonly label?: Accessor<string>
  readonly prefix?: string
}

export const ItemHeader = (props: HeaderProps) => {
  const status = () => props.status?.() ?? props.item().status
  const glyph = () => statusGlyph(status(), props.frame(), props.animate())
  const color = () => (props.selected?.() === true ? colors.blue : (props.tone ?? statusColor(status())))
  const label = () => props.label?.() ?? titleFor(props.item())
  return (
    <text width="100%" selectable={false} onMouseDown={() => props.onToggle?.()} fg={colors.text} wrapMode="none">
      <Show when={props.prefix !== undefined}>
        <span style={{ fg: colors.subtle }}>{props.prefix}</span>
      </Show>
      <span style={{ fg: color(), bold: props.selected?.() === true }}>{glyph()}</span>
      <span style={{ fg: props.selected?.() === true ? colors.blue : colors.text, bold: props.selected?.() === true }}>
        {` ${label()}`}
      </span>
      <Show when={props.expanded !== undefined}>
        <span style={{ fg: props.selected?.() === true ? colors.blue : colors.subtle }}>
          {props.expanded?.() === true ? " ▾" : " ▸"}
        </span>
      </Show>
    </text>
  )
}

export const DiffHeader = (props: {
  readonly item: TranscriptItem
  readonly expanded: Accessor<boolean>
  readonly selected: Accessor<boolean>
  readonly toggle: () => void
  readonly select: () => void
}) => (
  <text
    width="100%"
    selectable={false}
    onMouseDown={() => {
      props.select()
      props.toggle()
    }}
    wrapMode="none"
  >
    <span style={{ fg: props.selected() ? colors.blue : colors.teal, bold: props.selected() }}>Δ</span>
    <span
      style={{ fg: props.selected() ? colors.blue : colors.text, bold: props.selected() }}
    >{` ${titleFor(props.item)}`}</span>
    <span style={{ fg: props.selected() ? colors.blue : colors.subtle }}>{props.expanded() ? " ▾" : " ▸"}</span>
  </text>
)

export const toolHasBody = (tool: ToolPresentation): boolean =>
  tool.output.trim().length > 0 || tool.additions > 0 || tool.removals > 0

const indentText = (text: string, indent = 2): string => {
  const prefix = " ".repeat(Math.max(0, indent))
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n")
}

export const toolExpandable = (items: readonly ToolPresentation[]): boolean =>
  items.length > 1 || items.some(toolHasBody)

export const toolDefaultExpanded = (items: readonly ToolPresentation[]): boolean =>
  items.some((tool) => tool.family === "edit" && isActive(tool.item.status))

const singleEditLabel = (tool: ToolPresentation, running: boolean): string => {
  const path = firstPath(tool)
  const subject = path ?? (tool.paths.length > 1 ? plural(tool.paths.length, "file") : "file")
  return `${running ? "Editing" : "Edited"} ${subject}`
}

const singleExploreLabel = (tool: ToolPresentation): string => {
  const verb = tool.action === "search" ? "Search" : "Read"
  const path = firstPath(tool)
  return path === undefined ? verb : `${verb} ${path}`
}

const singleShellLabel = (tool: ToolPresentation): string => {
  const command = tool.command ?? tool.item.title
  return command.length > 0 ? `$ ${command}` : "Shell command"
}

const singleToolLabel = (tool: ToolPresentation, running: boolean): string => {
  if (tool.item.title.length > 0 && tool.item.title !== "Tool") return tool.item.title
  switch (tool.family) {
    case "explore":
      return singleExploreLabel(tool)
    case "edit":
      return singleEditLabel(tool, running)
    case "shell":
      return singleShellLabel(tool)
    case "other":
      return titleFor(tool.item)
  }
}

const multiEditLabel = (items: readonly ToolPresentation[], running: boolean): string => {
  const paths = [...new Set(items.flatMap((tool) => tool.paths))]
  const onlyPath = paths[0]
  const label =
    paths.length === 1 && onlyPath !== undefined ? onlyPath : plural(Math.max(paths.length, items.length), "file")
  return `${running ? "Editing" : "Edited"} ${label}`
}

export const toolGroupLabel = (items: readonly ToolPresentation[]): string => {
  const first = items[0]
  if (first === undefined) return "Tool"
  const running = isActive(aggregateActivity(items.map((tool) => tool.item.status)))
  if (items.length === 1) return singleToolLabel(first, running)
  if (first.family === "edit") return multiEditLabel(items, running)
  if (first.family === "shell") return `${running ? "Running" : "Ran"} ${plural(items.length, "command")}`
  return titleFor(first.item)
}

export const ToolBody = (props: { readonly tool: ToolPresentation; readonly indent?: number }) => {
  const source = () => props.tool.output
  const path = firstPath(props.tool)
  const indent = props.indent ?? 2
  if (
    props.tool.family === "explore" &&
    source()
      .split("\n")
      .some((line) => /^\d+: ?/u.test(line))
  )
    return <StyledBody source={source} path={path} kind="read" indent={indent} />
  if (
    props.tool.family === "edit" &&
    source()
      .split("\n")
      .some((line) => line.startsWith("+") || line.startsWith("-") || line.startsWith("@@ "))
  )
    return <StyledBody source={source} kind="diff" indent={indent} />
  if (props.tool.family === "shell")
    return <PlainBody source={() => indentText(source(), indent)} fg={colors.muted} wrapMode="char" />
  if (props.tool.family === "other") return <MarkdownBody source={source} />
  return <PlainBody source={() => indentText(source(), indent)} fg={colors.muted} wrapMode="char" />
}
