import { StyledText, bold, fg } from "@opentui/core"
import type { TextChunk } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { Effect, Schedule } from "effect"
import { For, Show, createMemo, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import type { Client, ThreadView } from "../client/model"
import { colors, modeColor, modeColors } from "./theme"
import type { FocusPanel } from "./types"

export const contextSidebarWidth = 31

export const isBusy = (thread: ThreadView | undefined): boolean =>
  thread?.activity === "working" || thread?.activity === "waiting"

interface ContextSidebarProps {
  readonly client: Client
  readonly thread: Accessor<ThreadView | undefined>
  readonly focus: Accessor<FocusPanel>
  readonly setFocus: (focus: FocusPanel) => void
}

export function ContextSidebar(props: ContextSidebarProps) {
  const thread = () => props.thread()
  const approval = () => thread()?.approval
  const childCount = () => thread()?.items.filter((item) => item.kind === "child").length ?? 0
  const hasContext = () => approval() !== null || childCount() > 0

  return (
    <Show when={hasContext()}>
      <box
        width={contextSidebarWidth}
        minWidth={contextSidebarWidth}
        maxWidth={36}
        flexDirection="column"
        overflow="hidden"
        border
        borderStyle="rounded"
        borderColor={props.focus() === "context" ? colors.teal : colors.subtle}
        padding={1}
        onMouseDown={() => props.setFocus("context")}
      >
        <text fg={colors.teal} content="CONTEXT" />
        <scrollbox width="100%" flexGrow={1} minHeight={0}>
          <Show when={approval() !== null}>
            <box border borderStyle="rounded" borderColor={colors.amber} padding={1} marginTop={1}>
              <text fg={colors.amber} content="APPROVAL REQUIRED" />
              <text fg={colors.text} content={approval()?.title ?? "Authorization request"} truncate />
              <text fg={colors.muted} content={approval()?.detail ?? "Confirm this operation"} wrapMode="word" />
              <box height={1} flexDirection="row" gap={1}>
                <text
                  width={12}
                  height={1}
                  flexShrink={0}
                  fg={colors.green}
                  content="[A] approve"
                  onMouseDown={() => props.client.approve(true)}
                />
                <text
                  width={10}
                  height={1}
                  flexShrink={0}
                  fg={colors.red}
                  content="[D] deny"
                  onMouseDown={() => props.client.approve(false)}
                />
              </box>
            </box>
          </Show>
          <Show when={childCount() > 0}>
            <text fg={colors.purple} content={`CHILD RUNS  ${childCount()}`} />
            <For each={thread()?.items.filter((item) => item.kind === "child") ?? []}>
              {(item) => <text fg={colors.muted} content={`· ${item.title}`} wrapMode="word" />}
            </For>
          </Show>
        </scrollbox>
        <Show when={approval() !== null}>
          <text fg={colors.muted} content="A approve · D deny" />
        </Show>
      </box>
    </Show>
  )
}

export function WelcomePanel(props: { readonly client: Client; readonly animate?: boolean }) {
  const dimensions = useTerminalDimensions()
  const [phase, setPhase] = createSignal(0)
  const [impulses, setImpulses] = createSignal<readonly { column: number; row: number; phase: number }[]>([])
  onMount(() => {
    if (props.animate === false) return
    const timer = Effect.runFork(
      Effect.repeat(
        Effect.sync(() => {
          setPhase((value) => value + 1)
          setImpulses((values) => values.filter((value) => (phase() - value.phase) * 0.09 <= 3.2))
        }),
        Schedule.spaced(90),
      ),
    )
    onCleanup(() => timer.interruptUnsafe())
  })
  const geometry = createMemo(() => {
    const { width, height } = dimensions()
    const columns = Math.max(18, Math.min(56, Math.max(12, Math.floor(width / 2) - 2)))
    const rows = Math.max(9, Math.min(Math.max(9, height - 8), Math.round(columns * 0.5)))
    return {
      columns,
      rows,
      left: Math.max(0, Math.floor(width / 2) - columns - 2),
      top: Math.max(0, Math.floor((height - 5 - rows) / 2)),
    }
  })
  const shades = createMemo(() => {
    const hex = modeColors[props.client.state.mode]
    return new Map(
      ["●", "•", ":", "·", "."].map((glyph, index) => {
        const factor = [1, 0.84, 0.68, 0.52, 0.4][index] ?? 1
        const color = [1, 3, 5]
          .map((offset) =>
            Math.round(Number.parseInt(hex.slice(offset, offset + 2), 16) * factor)
              .toString(16)
              .padStart(2, "0"),
          )
          .join("")
        return [glyph, `#${color}`]
      }),
    )
  })
  const glyph = (column: number, row: number): string => {
    const { columns, rows } = geometry()
    const cx = (columns - 1) / 2
    const cy = (rows - 1) / 2
    const radius = Math.min(cx, cy / 0.5)
    const nx = (column - cx) / radius
    const ny = (row - cy) / (radius * 0.5)
    const squared = nx * nx + ny * ny
    if (squared > 1) return " "
    const nz = Math.sqrt(Math.max(0, 1 - squared))
    const angle = ((phase() % 120) / 120) * Math.PI * 2
    const lambert = Math.max(0, nx * -0.5 + ny * -0.58 + nz * 0.65)
    const shimmer = 0.5 + 0.5 * Math.sin(nx * 3.4 + ny * 2.6 - angle * 3)
    const ripple = 0.5 + 0.5 * Math.sin(nx * 7.1 - ny * 5.2 + angle * 2)
    let intensity = Math.max(0.08, lambert * 0.92 + shimmer * 0.18 + ripple * 0.08 - squared * 0.18)
    for (const impulse of impulses()) {
      const age = (phase() - impulse.phase) * 0.09
      const dx = nx - (impulse.column - cx) / radius
      const dy = ny - (impulse.row - cy) / (radius * 0.5)
      const front = Math.sqrt(dx * dx + dy * dy) - age * 1.6
      intensity += Math.exp(-(front * front) / 0.03) * 1.4 * Math.exp(-age * 1.2)
    }
    if (intensity >= 0.78) return "●"
    if (intensity >= 0.55) return "•"
    if (intensity >= 0.38) return ":"
    if (intensity >= 0.22) return "·"
    return "."
  }
  const content = createMemo(() => {
    const { width, height } = dimensions()
    const mode = props.client.state.mode
    if (height < 20 || width < 60) {
      const hint = width >= 28 ? "ctrl+o commands   ? help" : "ctrl+o / ?"
      return new StyledText([
        fg(colors.text)("\n"),
        bold(fg(modeColor(mode))(`${" ".repeat(Math.max(0, Math.floor((width - 15) / 2)))}Welcome to Rika`)),
        fg(colors.text)(`\n\n${" ".repeat(Math.max(0, Math.floor((width - hint.length) / 2)))}${hint}`),
      ])
    }
    const { columns, rows, left, top } = geometry()
    const copyTop = Math.floor((rows - 5) / 2)
    const copyLeft = Math.floor(width / 2) + 2
    const chunks: TextChunk[] = [fg(colors.text)("\n".repeat(top))]
    const copyRows = new Map<number, TextChunk[]>([
      [copyTop, [bold(fg(modeColor(mode))("Welcome to Rika"))]],
      [copyTop + 3, [bold(fg(colors.text)("ctrl+o")), fg(colors.muted)(" for commands")]],
      [copyTop + 4, [bold(fg(colors.text)("?")), fg(colors.muted)(" for shortcuts")]],
    ])
    for (let row = 0; row < rows; row += 1) {
      if (row > 0) chunks.push(fg(colors.text)("\n"))
      chunks.push(fg(colors.text)(" ".repeat(left)))
      const line = Array.from({ length: columns }, (_, column) => glyph(column, row)).join("")
      for (const run of line.match(/(.)\1*/gu) ?? []) chunks.push(fg(shades().get(run[0] ?? "") ?? colors.text)(run))
      const copy = copyRows.get(row)
      if (copy !== undefined) chunks.push(fg(colors.text)(" ".repeat(Math.max(1, copyLeft - left - columns))), ...copy)
    }
    return new StyledText(chunks)
  })
  return (
    <box flexGrow={1} minHeight={0} width="100%" overflow="hidden">
      <text
        width="100%"
        height="100%"
        wrapMode="none"
        onMouseDown={(event) =>
          setImpulses((values) => [
            ...values,
            { column: event.x - geometry().left, row: event.y - geometry().top, phase: phase() },
          ])
        }
      >
        <For each={content().chunks}>{(chunk) => <span style={chunk}>{chunk.text}</span>}</For>
      </text>
    </box>
  )
}
