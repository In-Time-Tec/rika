import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, type Accessor } from "solid-js"
import type { ThreadView } from "../client/model"
import { colors } from "./theme"
import { OverlayFrame } from "./overlays"
import { Transcript } from "./transcript"

export interface ThreadSwitcherProps {
  readonly threads: Accessor<readonly ThreadView[]>
  readonly kind: "switch" | "mention"
  readonly index: Accessor<number>
  readonly query: Accessor<string>
  readonly setQuery: (query: string) => void
  readonly choose: (thread: ThreadView | undefined) => void
  readonly close: () => void
}

export function ThreadSwitcherOverlay(props: ThreadSwitcherProps) {
  const dimensions = useTerminalDimensions()
  const horizontal = createMemo(() => dimensions().width >= 100)
  const geometry = createMemo(() => {
    const composerTop = Math.max(0, dimensions().height - 5)
    const height = Math.max(3, composerTop - 4)
    const width = Math.max(1, horizontal() ? Math.floor(dimensions().width * 0.65) : dimensions().width - 4)
    const contentHeight = Math.max(1, height - 5)
    const listHeight = horizontal()
      ? contentHeight
      : Math.max(5, Math.min(contentHeight - 4, Math.floor(contentHeight * 0.42)))
    const listWidth = horizontal() ? Math.max(1, Math.floor((width - 6) / 2)) : width - 4
    return {
      height,
      width,
      left: Math.max(0, Math.floor((dimensions().width - width) / 2)),
      top: Math.max(0, composerTop - height - 1),
      listHeight,
      listWidth,
      previewWidth: horizontal() ? Math.max(4, width - listWidth - 6) : width - 4,
      previewHeight: horizontal() ? Math.max(4, contentHeight - 1) : Math.max(4, contentHeight - listHeight - 2),
    }
  })
  const selected = createMemo(() => props.threads()[props.index()])
  const previewItems = createMemo(() => selected()?.items ?? [])
  let list: ScrollBoxRenderable | undefined
  createEffect(() => {
    const index = props.index()
    if (list === undefined) return
    if (index < list.scrollTop) list.scrollTo(index)
    else if (index >= list.scrollTop + list.height) list.scrollTo(index - list.height + 1)
  })
  return (
    <OverlayFrame
      title={props.kind === "mention" ? "Mention Thread" : "Switch Thread"}
      height={geometry().height}
      width={geometry().width}
      left={geometry().left}
      top={geometry().top}
      color={colors.gold}
      footer="Opt+W/Ctrl+T all workspaces ── Esc close"
    >
      <box height={1} flexShrink={0} />
      <box
        width="100%"
        flexGrow={1}
        minHeight={0}
        flexDirection={horizontal() ? "row" : "column"}
        gap={horizontal() ? 2 : 0}
        marginBottom={2}
      >
        <box
          width={horizontal() ? geometry().listWidth : "100%"}
          height={horizontal() ? "100%" : geometry().listHeight}
          flexDirection="column"
          flexShrink={0}
          minHeight={0}
        >
          <box width="100%" height={1} flexShrink={0} flexDirection="row">
            <text width={2} height={1} fg={colors.text} content="> " />
            <input
              flexGrow={1}
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
          <box height={1} flexShrink={0} />
          <scrollbox
            scrollX={false}
            scrollbarOptions={{ visible: false }}
            ref={(node) => {
              list = node
            }}
            width="100%"
            flexGrow={1}
            minHeight={0}
            contentOptions={{ flexDirection: "column" }}
          >
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
                      content={` ${thread.title}`}
                    />
                    <text
                      width={Math.min(10, Math.max(1, geometry().listWidth - 3))}
                      height={1}
                      truncate
                      fg={active() ? colors.selectionFg : colors.muted}
                      content={thread.activity.padStart(9) + " "}
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
          <Show
            when={previewItems().length > 0}
            fallback={
              <box flexGrow={1} alignItems="center" justifyContent="center">
                <text fg={colors.muted} content="No preview" />
              </box>
            }
          >
            <Transcript items={previewItems()} active={false} animate={false} width={geometry().previewWidth - 4} />
          </Show>
        </box>
      </box>
    </OverlayFrame>
  )
}
