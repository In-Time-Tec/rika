import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, createMemo, type Accessor } from "solid-js"
import type { ThreadView } from "../client/model"
import { colors, modeColor } from "./theme"
import { OverlayFrame } from "./overlays"

export interface ThreadSwitcherProps {
  readonly threads: Accessor<readonly ThreadView[]>
  readonly kind: "switch" | "mention"
  readonly index: Accessor<number>
  readonly query: Accessor<string>
  readonly setQuery: (query: string) => void
  readonly choose: (thread: ThreadView | undefined) => void
  readonly close: () => void
}

const threadPreviewItems = (thread: ThreadView | undefined): readonly ThreadView["items"][number][] =>
  thread?.items.slice(-6) ?? []

export function ThreadSwitcherOverlay(props: ThreadSwitcherProps) {
  const dimensions = useTerminalDimensions()
  const horizontal = createMemo(() => dimensions().width >= 120)
  const geometry = createMemo(() => {
    const composerTop = Math.max(0, dimensions().height - 5)
    const height = Math.min(Math.max(6, composerTop - 2), composerTop)
    const width = Math.max(1, Math.min(140, dimensions().width - 4))
    const contentHeight = Math.max(1, height - 2)
    const listHeight = horizontal()
      ? contentHeight
      : Math.max(5, Math.min(contentHeight - 4, Math.floor(contentHeight * 0.42)))
    const listWidth = horizontal() ? Math.max(1, Math.floor((width - 2) / 2)) : width
    return {
      height,
      width,
      left: Math.max(0, Math.floor((dimensions().width - width) / 2)),
      top: Math.max(0, composerTop - height),
      listHeight,
      listWidth,
      previewWidth: horizontal() ? Math.max(4, width - listWidth - 2) : width,
      previewHeight: horizontal() ? Math.max(4, contentHeight - 1) : Math.max(4, contentHeight - listHeight - 2),
    }
  })
  const selected = createMemo(() => props.threads()[props.index()])
  const previewItems = createMemo(() => threadPreviewItems(selected()))
  return (
    <OverlayFrame
      title={props.kind === "mention" ? "Mention Thread" : "Switch Thread"}
      height={geometry().height}
      width={geometry().width}
      left={geometry().left}
      top={geometry().top}
      color={modeColor("high")}
    >
      <box
        width="100%"
        flexGrow={1}
        minHeight={0}
        flexDirection={horizontal() ? "row" : "column"}
        gap={horizontal() ? 1 : 0}
      >
        <box
          width={horizontal() ? geometry().listWidth : "100%"}
          height={horizontal() ? "100%" : geometry().listHeight}
          flexDirection="column"
          flexShrink={0}
          minHeight={0}
        >
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
          <scrollbox width="100%" flexGrow={1} minHeight={0} contentOptions={{ flexDirection: "column" }}>
            <For each={props.threads()}>
              {(thread, index) => {
                const active = () => index() === props.index()
                return (
                  <box
                    width="100%"
                    height={1}
                    flexShrink={0}
                    flexDirection="row"
                    backgroundColor={active() ? colors.selectionBg : colors.surface}
                    onMouseDown={() => props.choose(thread)}
                  >
                    <text
                      flexGrow={1}
                      minWidth={0}
                      height={1}
                      truncate
                      fg={active() ? colors.selectionFg : colors.text}
                      content={`${active() ? ">" : " "} ${thread.title}`}
                    />
                    <text
                      width={Math.min(24, Math.max(1, geometry().listWidth - 3))}
                      height={1}
                      truncate
                      fg={active() ? colors.selectionFg : colors.muted}
                      content={`${thread.target} · ${thread.activity}`.padStart(
                        Math.min(24, Math.max(1, geometry().listWidth - 3)),
                      )}
                    />
                  </box>
                )
              }}
            </For>
            <Show when={props.threads().length === 0}>
              <text width="100%" fg={colors.muted} content="No matching threads" />
            </Show>
          </scrollbox>
        </box>
        <box
          width={horizontal() ? geometry().previewWidth : "100%"}
          height={horizontal() ? "100%" : geometry().previewHeight}
          flexGrow={horizontal() ? 1 : 0}
          minHeight={0}
          flexDirection="column"
          overflow="hidden"
          border
          borderStyle="rounded"
          borderColor={colors.muted}
          backgroundColor={colors.surface}
          title=" Thread Preview "
          titleAlignment="center"
          titleColor={colors.muted}
          paddingLeft={1}
          paddingRight={1}
        >
          <Show when={selected()} fallback={<text fg={colors.muted} content="No preview" />}>
            <scrollbox width="100%" flexGrow={1} minHeight={0} contentOptions={{ flexDirection: "column" }}>
              <For each={previewItems()}>
                {(item) => (
                  <box width="100%" flexDirection="column" flexShrink={0} marginBottom={1}>
                    <text width="100%" height={1} truncate fg={colors.muted} content={item.title || item.kind} />
                    <Show when={item.text.length > 0}>
                      <text width="100%" fg={colors.text} content={item.text} wrapMode="word" selectable />
                    </Show>
                  </box>
                )}
              </For>
            </scrollbox>
          </Show>
        </box>
      </box>
      <text
        width="100%"
        height={1}
        flexShrink={0}
        truncate
        fg={colors.muted}
        content="Opt+W/Ctrl+T all workspaces · Esc close"
        onMouseDown={props.close}
      />
    </OverlayFrame>
  )
}
