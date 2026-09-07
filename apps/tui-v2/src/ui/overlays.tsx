import type { ColorInput, ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import type { Mode, ThreadView } from "../client/model"
import { colors, modeColor } from "./theme"
import { contextPercent } from "./composer/usage"

export interface PaletteEntry {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly run: () => void
}

export interface PaletteProps {
  readonly title?: string
  readonly entries: Accessor<readonly PaletteEntry[]>
  readonly index: Accessor<number>
  readonly query: Accessor<string>
  readonly setQuery: (query: string) => void
  readonly choose: (entry: PaletteEntry | undefined) => void
  readonly close: () => void
}

export const modeOrder: readonly Mode[] = ["low", "medium", "high", "ultra"]

const paletteLabels = new Map<string, readonly [string, string]>([
  ["new-thread", ["thread", "new"]],
  ["new-orb-thread", ["thread", "new in Orb"]],
  ["switch-thread", ["thread", "switch"]],
  ["mode", ["mode", "change mode"]],
  ["context", ["usage", "show context and usage"]],
  ["workspace-files", ["files", "toggle file tree"]],
  ["changed-files", ["files", "toggle changed files"]],
  ["shortcuts", ["rika", "show shortcuts"]],
  ["cancel", ["rika", "cancel current run"]],
  ["quit", ["rika", "quit"]],
])

interface OverlayFrameProps {
  readonly title: string
  readonly height: number
  readonly width?: number
  readonly left?: number
  readonly top?: number
  readonly color?: ColorInput
  readonly footer?: string
  readonly children: JSX.Element
}

export function OverlayFrame(props: OverlayFrameProps) {
  const dimensions = useTerminalDimensions()
  const width = () => props.width ?? Math.max(1, dimensions().width - 4)
  const left = () => props.left ?? Math.max(0, Math.floor((dimensions().width - width()) / 2))
  const top = () => props.top ?? 2
  return (
    <box
      position="absolute"
      top={top()}
      left={left()}
      width={width()}
      height={Math.max(3, props.height)}
      flexDirection="column"
      overflow="hidden"
      zIndex={30}
      border
      borderStyle="rounded"
      borderColor={colors.text}
      backgroundColor={colors.surface}
      title={` ${props.title} `}
      titleColor={props.color ?? colors.teal}
      bottomTitle={props.footer !== undefined ? ` ${props.footer} ` : ""}
      bottomTitleAlignment="right"
      paddingLeft={1}
      paddingRight={1}
    >
      {props.children}
    </box>
  )
}

export function CommandPalette(props: PaletteProps) {
  const dimensions = useTerminalDimensions()
  const width = () => Math.max(1, Math.min(78, dimensions().width - 4))
  const visibleRows = () => Math.max(1, Math.min(14, dimensions().height) - 5)
  const [scrollTop, setScrollTop] = createSignal(0)
  const windowStart = createMemo(() =>
    Math.max(0, Math.min(Math.floor(scrollTop()) - 8, props.entries().length - visibleRows())),
  )
  const windowEnd = createMemo(() => Math.min(props.entries().length, windowStart() + visibleRows() + 16))
  const visibleEntries = createMemo(() => props.entries().slice(windowStart(), windowEnd()))
  let list: ScrollBoxRenderable | undefined
  const trackScroll = (event: { readonly position: number }) => setScrollTop(event.position)
  onCleanup(() => list?.verticalScrollBar.off("change", trackScroll))
  createEffect(() => {
    const index = Math.max(0, Math.min(props.index(), props.entries().length - 1))
    const rows = visibleRows()
    if (list === undefined) return
    if (index < list.scrollTop) list.scrollTo(index)
    else if (index >= list.scrollTop + rows) list.scrollTo(index - rows + 1)
  })
  return (
    <OverlayFrame
      title={props.title ?? "Command Palette"}
      height={Math.min(14, dimensions().height)}
      width={width()}
      top={Math.max(0, Math.floor((dimensions().height - 19) / 2))}
      color={colors.gold}
    >
      <box width="100%" height={1} flexShrink={0} flexDirection="row">
        <text width={2} height={1} fg={colors.text} content="> " />
        <input
          flexGrow={1}
          width="100%"
          flexShrink={0}
          value={props.query()}
          focused
          placeholder=""
          placeholderColor={colors.muted}
          textColor={colors.text}
          focusedTextColor={colors.text}
          backgroundColor={colors.surface}
          focusedBackgroundColor={colors.surface}
          onInput={props.setQuery}
        />
      </box>
      <box height={2} flexShrink={0} />
      <scrollbox
        id="command-palette-list"
        scrollX={false}
        scrollbarOptions={{ visible: false }}
        ref={(node) => {
          list = node
          node.verticalScrollBar.on("change", trackScroll)
        }}
        width="100%"
        flexGrow={1}
        minHeight={0}
        contentOptions={{ flexDirection: "column" }}
      >
        <box height={windowStart()} flexShrink={0} />
        <For each={visibleEntries()}>
          {(entry, index) => {
            const active = () => windowStart() + index() === props.index()
            return (
              <box
                id={`command-palette-entry-${entry.id}`}
                height={1}
                flexShrink={0}
                width="100%"
                flexDirection="row"
                backgroundColor={active() ? colors.selectionBg : colors.surface}
                onMouseDown={() => props.choose(entry)}
              >
                <Show when={width() >= 50}>
                  <text
                    width={18}
                    height={1}
                    fg={active() ? colors.selectionFg : colors.muted}
                    content={`${(paletteLabels.get(entry.id)?.[0] ?? "").padStart(16)}  `}
                  />
                </Show>
                <text
                  flexGrow={1}
                  minWidth={0}
                  height={1}
                  truncate
                  fg={active() ? colors.selectionFg : colors.text}
                  content={paletteLabels.get(entry.id)?.[1] ?? entry.label}
                />
                <Show when={width() >= 50}>
                  <text
                    width={14}
                    height={1}
                    truncate
                    fg={active() ? colors.selectionFg : colors.muted}
                    content={entry.detail.padStart(13) + " "}
                  />
                </Show>
              </box>
            )
          }}
        </For>
        <box height={Math.max(0, props.entries().length - windowEnd())} flexShrink={0} />
        <Show when={props.entries().length === 0}>
          <text width="100%" fg={colors.muted} content="No matching actions" />
        </Show>
      </scrollbox>
    </OverlayFrame>
  )
}

export function ExitOverlay(props: {
  readonly quit: () => void
  readonly close: () => void
  readonly contentWidth?: number
  readonly archiveAndNew?: () => void
  readonly archiveAndQuit?: () => void
}) {
  const dimensions = useTerminalDimensions()
  const width = () => Math.max(1, Math.min(33, (props.contentWidth ?? dimensions().width) - 4))
  return (
    <OverlayFrame
      title="Ctrl+C then"
      height={6}
      width={width()}
      left={Math.max(0, (props.contentWidth ?? dimensions().width) - width() - 2)}
      top={Math.max(0, dimensions().height - 13)}
      color={colors.amber}
    >
      <text width="100%" height={1} truncate onMouseDown={() => props.archiveAndNew?.()}>
        <span style={{ fg: colors.blue }}>Ctrl+N</span>
        <span style={{ fg: colors.text }}> Archive and new thread</span>
      </text>
      <text width="100%" height={1} truncate onMouseDown={() => props.archiveAndQuit?.()}>
        <span style={{ fg: colors.blue }}>Ctrl+E</span>
        <span style={{ fg: colors.text }}> Archive and quit</span>
      </text>
      <text width="100%" height={1} truncate onMouseDown={props.quit}>
        <span style={{ fg: colors.blue }}>Ctrl+C</span>
        <span style={{ fg: colors.text }}> Quit</span>
      </text>
      <text width="100%" height={1} truncate onMouseDown={props.close}>
        <span style={{ fg: colors.blue }}>{"         Esc"}</span>
        <span style={{ fg: colors.muted }}> cancel</span>
      </text>
    </OverlayFrame>
  )
}

export interface ModeOverlayProps {
  readonly contentWidth?: number
  readonly mode: Mode
  readonly index: Accessor<number>
  readonly choose: (mode: Mode) => void
  readonly close: () => void
}

export function ModeOverlay(props: ModeOverlayProps) {
  const dimensions = useTerminalDimensions()
  const geometry = createMemo(() => {
    const composerTop = Math.max(0, dimensions().height - 5)
    const contentWidth = props.contentWidth ?? dimensions().width
    const width = Math.max(1, Math.min(58, contentWidth - 4))
    const height = Math.min(15, Math.max(1, composerTop))
    return {
      width,
      height,
      left: Math.max(0, contentWidth - width - 2),
      top: Math.max(0, composerTop - height - 1),
    }
  })
  return (
    <OverlayFrame
      title="Mode"
      height={geometry().height}
      width={geometry().width}
      left={geometry().left}
      top={geometry().top}
      color={modeColor(modeOrder[props.index()] ?? props.mode)}
      footer="↔ turn ── esc"
    >
      <box height={1} flexShrink={0} />
      <box width="100%" height={1} flexShrink={0} flexDirection="row">
        <For each={modeOrder}>
          {(mode, index) => (
            <box width="25%" height={1} onMouseDown={() => props.choose(mode)}>
              <text
                width="100%"
                height={1}
                fg={modeColor(modeOrder[props.index()] ?? props.mode)}
                content={(index() === props.index() ? "━" : "┄").repeat(geometry().width)}
              />
            </box>
          )}
        </For>
      </box>
      <box width="100%" height={1} flexShrink={0} flexDirection="row" justifyContent="space-between">
        <For each={modeOrder}>
          {(mode, index) => (
            <text
              height={1}
              fg={index() === props.index() ? modeColor(mode) : colors.muted}
              content={mode}
              onMouseDown={() => props.choose(mode)}
            />
          )}
        </For>
      </box>
      <box height={1} flexShrink={0} />
      <OverlaySection title="Route" width={geometry().width} />
      <box height={1} flexShrink={0} />
      <text
        width="100%"
        height={1}
        truncate
        fg={colors.text}
        content={`Agent     GPT-5.6 Terra ${["low", "xhigh", "xhigh", "xhigh"][props.index()] ?? "xhigh"}`}
      />
      <text
        width="100%"
        height={1}
        truncate
        fg={colors.text}
        content={`Oracle    GPT-5.6 Sol ${["low", "medium", "high", "xhigh"][props.index()] ?? "medium"}`}
      />
      <box height={1} flexShrink={0} />
      <OverlaySection title="About" width={geometry().width} />
      <box height={1} flexShrink={0} />
      <text
        width="100%"
        height={1}
        truncate
        fg={colors.text}
        content={
          [
            "Fast and economical for focused tasks",
            "Balanced default for everyday work",
            "More reasoning for demanding work",
            "Maximum reasoning for the hardest problems",
          ][props.index()] ?? "Balanced default for everyday work"
        }
      />
    </OverlayFrame>
  )
}

function OverlaySection(props: { readonly title: string; readonly width: number }) {
  return (
    <text width="100%" height={1} flexShrink={0} truncate>
      <span style={{ fg: colors.muted }}>{props.title}</span>
      <span style={{ fg: colors.text }}>{` ${"─".repeat(Math.max(0, props.width - props.title.length - 5))}`}</span>
    </text>
  )
}

export function ContextOverlay(props: {
  readonly contentWidth?: number
  readonly mode?: Mode
  readonly thread: Accessor<ThreadView | undefined>
  readonly close: () => void
}) {
  const dimensions = useTerminalDimensions()
  const used = createMemo(() => contextPercent(props.thread()))
  const composerTop = () => Math.max(0, dimensions().height - 5)
  const width = () => Math.max(1, Math.min(68, (props.contentWidth ?? dimensions().width) - 4))
  const height = () => Math.min(18, Math.max(1, composerTop()))
  return (
    <OverlayFrame
      title="Context & Usage"
      height={height()}
      width={width()}
      left={Math.max(0, (props.contentWidth ?? dimensions().width) - width() - 2)}
      top={Math.max(0, composerTop() - height() - 1)}
      color={modeColor(props.mode ?? "medium")}
      footer="Ctrl+Y toggle ── esc"
    >
      <scrollbox flexGrow={1} minHeight={0} width="100%" scrollX={false} scrollbarOptions={{ visible: false }}>
        <box height={1} flexShrink={0} />
        <text
          width="100%"
          height={1}
          fg={modeColor(props.mode ?? "medium")}
          content={`${"━".repeat(Math.floor(used() / 5))}ᗧ${"·".repeat(20 - Math.floor(used() / 5))} ${used()}%`}
        />
        <box height={1} flexShrink={0} />
        <text
          width="100%"
          height={2}
          fg={colors.text}
          content={`Used        ${used() === 0 ? "0" : `${((258.4 * used()) / 100).toFixed(1)}K`}\nAvailable   ${((258.4 * (100 - used())) / 100).toFixed(1)}K`}
        />
        <box height={1} flexShrink={0} />
        <OverlaySection title="Window" width={width()} />
        <box height={1} flexShrink={0} />
        <text width="100%" height={2} fg={colors.text} content="Usable     258.4K\nFull       272K" />
        <box height={1} flexShrink={0} />
        <OverlaySection title="Session" width={width()} />
        <box height={1} flexShrink={0} />
        <text width="100%" height={3} fg={colors.text} content="Cost       —\nCached     —\nActive     ◷ —" />
      </scrollbox>
    </OverlayFrame>
  )
}

export function FileCompletionOverlay(props: {
  readonly entries: readonly string[]
  readonly index: Accessor<number>
  readonly choose: (entry: string) => void
}) {
  const dimensions = useTerminalDimensions()
  const geometry = createMemo(() => {
    const composerTop = Math.max(0, dimensions().height - 5)
    const visibleEntries = props.entries.slice(0, Math.max(1, Math.min(20, composerTop - 1)))
    const innerWidth = Math.max(19, ...visibleEntries.map((entry) => entry.length + 1))
    const width = Math.max(1, Math.min(innerWidth + 4, Math.max(1, dimensions().width - 4)))
    const height = Math.min(Math.max(3, visibleEntries.length + 2), Math.max(1, composerTop))
    return {
      width,
      height,
      left: 2,
      top: Math.max(0, composerTop - height),
    }
  })
  return (
    <OverlayFrame
      title=""
      height={geometry().height}
      width={geometry().width}
      left={geometry().left}
      top={geometry().top}
      color={colors.purple}
    >
      <scrollbox width="100%" flexGrow={1} minHeight={0} contentOptions={{ flexDirection: "column" }}>
        <For each={props.entries}>
          {(entry, index) => {
            const active = () => index() === props.index()
            return (
              <text
                width="100%"
                height={1}
                flexShrink={0}
                truncate
                bg={active() ? colors.muted : colors.surface}
                fg={colors.teal}
                content={`@${entry}`}
                onMouseDown={() => props.choose(entry)}
              />
            )
          }}
        </For>
        <Show when={props.entries.length === 0}>
          <text width="100%" fg={colors.muted} content="no matches" />
        </Show>
      </scrollbox>
    </OverlayFrame>
  )
}
export function FilePreviewOverlay(props: {
  readonly path: string
  readonly content: string
  readonly close: () => void
}) {
  const dimensions = useTerminalDimensions()
  const composerTop = Math.max(0, dimensions().height - 5)
  const width = Math.max(1, Math.min(96, dimensions().width - 4))
  const height = Math.min(Math.max(6, composerTop - 2), composerTop)
  return (
    <OverlayFrame
      title={props.path}
      height={height}
      width={width}
      left={Math.max(2, Math.floor((dimensions().width - width) / 2))}
      top={Math.max(2, composerTop - height)}
      color={colors.green}
    >
      <scrollbox width="100%" flexGrow={1} minHeight={0}>
        <text width="100%" fg={colors.text} content={props.content} selectable wrapMode="none" />
      </scrollbox>
      <text width="100%" height={1} flexShrink={0} fg={colors.muted} content="Esc close" onMouseDown={props.close} />
    </OverlayFrame>
  )
}
