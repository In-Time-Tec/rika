import type { StyledText } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, createContext, createMemo, useContext, type Accessor } from "solid-js"
import { colors } from "./theme"

export const TranscriptWidth = createContext<Accessor<number>>()

export function StyledChunks(props: { readonly content: StyledText }) {
  return (
    <For each={props.content.chunks}>
      {(chunk) => (
        <span
          style={{ fg: chunk.fg ?? colors.text, bg: chunk.bg ?? colors.surface, attributes: chunk.attributes ?? 0 }}
        >
          {chunk.text}
        </span>
      )}
    </For>
  )
}

export function StyledBlock(props: { readonly render: (width: number) => StyledText }) {
  const dimensions = useTerminalDimensions()
  const width = useContext(TranscriptWidth) ?? (() => dimensions().width)
  const content = createMemo(() => props.render(Math.max(8, width() - 4)))
  return (
    <text width="100%" wrapMode="none" selectable selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
      <StyledChunks content={content()} />
    </text>
  )
}
