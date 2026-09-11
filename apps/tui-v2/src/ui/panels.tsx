import { useTerminalDimensions } from "@opentui/solid"
import type { ColorInput, StyledText } from "@opentui/core"
import { For, Show, createMemo, type Accessor, type JSX } from "solid-js"
import { initial } from "@rika/terminal/terminal-state"
import { renderFileRows, sidebarFileRows } from "@rika/terminal/terminal-file-presentation"
import type { Mode, PendingTurn, ThreadView, TranscriptItem } from "../client/model"
import { colors, modeColor } from "./theme"
import { diffCounts } from "./transcript/presenter"
import { StyledChunks } from "./styled"

export interface FileSidebarProps {
  readonly files: readonly string[]
  readonly diffs: readonly TranscriptItem[]
  readonly kind: "workspace" | "changed"
  readonly width: number
  readonly mode: Mode
  readonly workspace: string
  readonly open: (path: string) => void
}

const changedFilesFor = (diffs: readonly TranscriptItem[]) =>
  diffs.map((item) => {
    const [added, removed] = diffCounts(item.text)
    return {
      path: item.title.length > 0 ? item.title : "changed file",
      status: "M",
      added,
      removed,
    }
  })

const fileRowsFor = (props: FileSidebarProps) => {
  const model = initial(props.workspace.length === 0 ? process.cwd() : props.workspace, props.mode)
  return sidebarFileRows(
    {
      ...model,
      changedFilesOpen: props.kind === "changed",
      changedFiles: { _tag: "Ready" as const, value: changedFilesFor(props.diffs) },
      filePicker: {
        ...model.filePicker,
        items: { _tag: "Ready" as const, value: [...props.files] },
      },
    },
    Math.max(1, Math.floor(props.width) - 8),
  )
}

export function FileSidebar(props: FileSidebarProps): JSX.Element {
  const rows = createMemo(() => fileRowsFor(props))
  const title = createMemo(() => {
    const count = props.kind === "changed" ? changedFilesFor(props.diffs).length : props.files.length
    return `${props.kind === "changed" ? "Changed files" : "Files"} (${count})`
  })
  const titleColor = createMemo<ColorInput>(() => modeColor(props.mode))
  return (
    <box
      width={Math.max(1, Math.floor(props.width) - 1)}
      marginLeft={1}
      height="100%"
      flexShrink={0}
      minHeight={0}
      flexDirection="column"
      overflow="hidden"
      border
      borderStyle="rounded"
      borderColor={colors.text}
      focusedBorderColor={colors.text}
      backgroundColor={colors.surface}
      title={` ${title()} `}
      titleAlignment="left"
      titleColor={titleColor()}
      paddingLeft={1}
      paddingRight={1}
    >
      <scrollbox
        width="100%"
        height="100%"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        scrollY
        scrollX={false}
        viewportCulling
        contentOptions={{ flexDirection: "column" }}
      >
        <For each={rows()}>
          {(row) => {
            const path = row.file?.path
            const content = createMemo<StyledText>(() => renderFileRows([row]))
            return (
              <text
                width="100%"
                flexShrink={0}
                selectable={false}
                wrapMode="none"
                onMouseDown={() => {
                  if (path !== undefined) props.open(path)
                }}
              >
                <StyledChunks content={content()} />
              </text>
            )
          }}
        </For>
      </scrollbox>
    </box>
  )
}

export interface PendingQueueProps {
  readonly thread: Accessor<ThreadView | undefined>
  readonly editingId?: string | undefined
  readonly selectedId?: string | undefined
  readonly select: (id: string) => void
  readonly edit: (id: string) => void
  readonly remove: (id: string) => void
  readonly steer: (id: string) => void
}

const queueLabel = (turn: PendingTurn): string =>
  `Queued · ${turn.prompt}${(turn.images ?? []).map((image) => `\n  ▧ ${image.path}`).join("")}`

const queueHints = (canSteer: boolean): string =>
  `${canSteer ? "Enter to steer ── " : ""}Backspace to dequeue ── Ctrl+E to edit`

const promptRows = (prompt: string, width: number): number => {
  const lines = prompt.split("\n")
  return lines.reduce(
    (count, line) => count + Math.max(1, Math.ceil(Math.max(1, line.length + 9) / Math.max(1, width))),
    0,
  )
}

export function PendingQueue(props: PendingQueueProps): JSX.Element {
  const dimensions = useTerminalDimensions()
  const pending = createMemo(() => (props.thread()?.pending ?? []).filter((item) => item.id !== props.editingId))
  const canSteer = createMemo(() => {
    const activity = props.thread()?.activity
    return activity === "working" || activity === "waiting"
  })
  const maxHeight = createMemo(() => Math.max(3, dimensions().height - 7))
  const height = createMemo(() => {
    const width = Math.max(1, dimensions().width - 4)
    let rows = 0
    for (const item of pending()) {
      rows += promptRows(queueLabel(item), width)
      if (rows >= maxHeight() - 2) return maxHeight()
    }
    return Math.min(maxHeight(), Math.max(3, rows + 2))
  })
  return (
    <Show when={pending().length > 0}>
      <box
        height={height()}
        maxHeight={maxHeight()}
        flexShrink={0}
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={colors.text}
        backgroundColor={colors.surface}
        paddingLeft={1}
        paddingRight={1}
        marginLeft={1}
        marginRight={1}
        marginBottom={-1}
      >
        <scrollbox
          width="100%"
          height="100%"
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          scrollY
          scrollX={false}
          viewportCulling
          contentOptions={{ flexDirection: "column" }}
        >
          <For each={pending()}>
            {(item) => {
              const selected = () => item.id === props.selectedId
              const label = () => queueLabel(item)
              return (
                <text
                  width="100%"
                  flexShrink={0}
                  selectable
                  selectionBg={colors.selectionBg}
                  selectionFg={colors.selectionFg}
                  wrapMode="word"
                  onMouseDown={() => props.select(item.id)}
                >
                  <span style={{ fg: selected() ? colors.text : colors.subtle, bold: selected() }}>{label()}</span>
                  <Show when={selected()}>
                    <span style={{ fg: modeColor("high"), bold: true }}>{`  ${queueHints(canSteer())}`}</span>
                  </Show>
                </text>
              )
            }}
          </For>
        </scrollbox>
      </box>
    </Show>
  )
}
