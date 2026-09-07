import type { ColorInput, ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import type { Mode, ThreadView } from "../client/model"
import { colors, modeColor } from "./theme"

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

interface OverlayFrameProps {
  readonly title: string
  readonly height: number
  readonly width?: number
  readonly left?: number
  readonly top?: number
  readonly color?: ColorInput
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
      borderColor={props.color ?? colors.teal}
      backgroundColor={colors.surface}
      title={` ${props.title} `}
      titleColor={props.color ?? colors.teal}
      paddingLeft={1}
      paddingRight={1}
    >
      {props.children}
    </box>
  )
}

export function CommandPalette(props: PaletteProps) {
  const dimensions = useTerminalDimensions()
  let list: ScrollBoxRenderable | undefined
  createEffect(() => {
    const index = props.index()
    if (list === undefined) return
    if (index < list.scrollTop) list.scrollTo(index)
    else if (index >= list.scrollTop + list.height) list.scrollTo(index - list.height + 1)
  })
  return (
    <OverlayFrame title={props.title ?? "Command Palette"} height={14}>
      <input
        width="100%"
        flexShrink={0}
        value={props.query()}
        focused
        placeholder=">"
        placeholderColor={colors.muted}
        textColor={colors.text}
        focusedTextColor={colors.text}
        backgroundColor={colors.surface}
        focusedBackgroundColor={colors.surface}
        onInput={props.setQuery}
      />
      <box height={1} flexShrink={0} />
      <scrollbox
        ref={(node) => {
          list = node
        }}
        width="100%"
        flexGrow={1}
        minHeight={0}
        contentOptions={{ flexDirection: "column" }}
      >
        <For each={props.entries()}>
          {(entry, index) => {
            const active = () => index() === props.index()
            return (
              <box
                height={1}
                flexShrink={0}
                width="100%"
                flexDirection="row"
                backgroundColor={active() ? colors.selectionBg : colors.surface}
                onMouseDown={() => props.choose(entry)}
              >
                <text
                  width={Math.max(1, dimensions().width - 9 - (dimensions().width >= 64 ? 24 : 0))}
                  height={1}
                  truncate
                  fg={active() ? colors.selectionFg : colors.text}
                  content={`${active() ? ">" : " "} ${entry.label}`}
                />
                <Show when={dimensions().width >= 64}>
                  <text
                    width={24}
                    height={1}
                    truncate
                    fg={active() ? colors.selectionFg : colors.muted}
                    content={entry.detail.padStart(24)}
                  />
                </Show>
              </box>
            )
          }}
        </For>
        <Show when={props.entries().length === 0}>
          <text width="100%" fg={colors.muted} content="No matching actions" />
        </Show>
      </scrollbox>
      <text
        width="100%"
        height={1}
        flexShrink={0}
        truncate
        fg={colors.muted}
        content="↑↓ select · Enter run · Esc close"
        onMouseDown={props.close}
      />
    </OverlayFrame>
  )
}

export function ExitOverlay(props: { readonly quit: () => void; readonly close: () => void }) {
  const dimensions = useTerminalDimensions()
  const composerTop = Math.max(0, dimensions().height - 5)
  return (
    <OverlayFrame title="Exit Rika?" height={7} top={Math.max(2, composerTop - 7)} color={colors.amber}>
      <text width="100%" fg={colors.text} content="Offline changes are not saved." />
      <box flexGrow={1} />
      <text width="100%" height={1} fg={colors.green} content="Enter exit" onMouseDown={props.quit} />
      <text width="100%" height={1} fg={colors.muted} content="Esc return" onMouseDown={props.close} />
    </OverlayFrame>
  )
}

export interface ModeOverlayProps {
  readonly mode: Mode
  readonly index: Accessor<number>
  readonly choose: (mode: Mode) => void
  readonly close: () => void
}

export function ModeOverlay(props: ModeOverlayProps) {
  const dimensions = useTerminalDimensions()
  const geometry = createMemo(() => {
    const composerTop = Math.max(0, dimensions().height - 5)
    const width = Math.max(1, Math.min(58, dimensions().width - 4))
    const height = Math.min(15, Math.max(1, composerTop))
    return { width, height, left: Math.max(2, dimensions().width - width - 2), top: Math.max(2, composerTop - height) }
  })
  return (
    <OverlayFrame
      title="Mode"
      height={geometry().height}
      width={geometry().width}
      left={geometry().left}
      top={geometry().top}
      color={modeColor(props.mode)}
    >
      <For each={modeOrder}>
        {(mode, index) => (
          <text
            width="100%"
            height={1}
            flexShrink={0}
            bg={index() === props.index() ? colors.selectionBg : colors.surface}
            fg={index() === props.index() ? colors.selectionFg : modeColor(mode)}
            content={`${index() === props.index() ? ">" : " "} ${mode}${props.mode === mode ? " · current" : ""}`}
            onMouseDown={() => props.choose(mode)}
          />
        )}
      </For>
      <text width="100%" height={1} truncate fg={colors.muted} content="Offline Agent and Oracle routes" />
      <box flexGrow={1} />
      <text
        width="100%"
        height={1}
        truncate
        fg={colors.muted}
        content="←↑↓→ select · Enter apply · Esc close"
        onMouseDown={props.close}
      />
    </OverlayFrame>
  )
}

export function ShortcutsOverlay(props: { readonly close: () => void }) {
  const rows = [
    "Ctrl+O  command palette",
    "Ctrl+T / Alt+W  switch Thread",
    "@  file completion · @@  mention Thread",
    "Ctrl+V  paste text/images",
    "Shift+Enter  newline",
    "Enter  submit / queue",
    "Ctrl+Enter  interrupt and send",
    "Ctrl+C  cancel / exit",
    "Ctrl+S  mode",
    "Ctrl+Y  context and usage",
    "Alt+T  workspace files",
    "Alt+S  changed files",
    "Ctrl+N  new Runner Thread",
    "Ctrl+Shift+N  new Orb Thread",
    "Tab / Shift+Tab  navigate details",
    "Ctrl+E  edit pending",
    "Backspace  dequeue pending",
    "Enter  steer selected pending",
    "Ctrl+1…9  load scenario",
    "PageUp / PageDown  transcript",
    "Ctrl+Home / End  transcript ends",
  ]
  const dimensions = useTerminalDimensions()
  const composerTop = Math.max(0, dimensions().height - 5)
  return (
    <OverlayFrame title="Shortcuts" height={Math.min(23, Math.max(3, composerTop - 2))} top={2}>
      <scrollbox flexGrow={1} minHeight={0} width="100%">
        <For each={rows}>
          {(row) => <text width="100%" height={1} flexShrink={0} truncate fg={colors.text} content={row} />}
        </For>
      </scrollbox>
      <text width="100%" height={1} flexShrink={0} fg={colors.muted} content="Esc close" onMouseDown={props.close} />
    </OverlayFrame>
  )
}

export function ContextOverlay(props: {
  readonly thread: Accessor<ThreadView | undefined>
  readonly close: () => void
}) {
  const dimensions = useTerminalDimensions()
  const used = createMemo(() => Math.min(99, (props.thread()?.items.length ?? 0) * 7))
  const composerTop = Math.max(0, dimensions().height - 5)
  const width = Math.max(1, Math.min(68, dimensions().width - 4))
  const height = Math.min(18, Math.max(1, composerTop))
  return (
    <OverlayFrame
      title="Context & Usage"
      height={height}
      width={width}
      left={Math.max(2, dimensions().width - width - 2)}
      top={Math.max(2, composerTop - height)}
      color={colors.blue}
    >
      <scrollbox flexGrow={1} minHeight={0} width="100%">
        <text width="100%" fg={colors.blue} content={`ᗧ······ ${used()}%`} />
        <text
          width="100%"
          fg={colors.text}
          content={`Used        ${used()}%\nAvailable   ${100 - used()}%\n\nWindow      200,000 tokens\nCost        $0.00\nCached      0 tokens`}
        />
        <text width="100%" fg={colors.muted} content="Deterministic offline usage fixture." />
      </scrollbox>
      <text width="100%" height={1} flexShrink={0} fg={colors.muted} content="Esc close" onMouseDown={props.close} />
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
