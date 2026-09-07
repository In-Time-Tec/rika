import type { RGBA, StyledText } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, createContext, createMemo, useContext, type Accessor } from "solid-js"
import { colors } from "./theme"

export const TranscriptWidth = createContext<Accessor<number>>()

const referenceColor = (color: RGBA | undefined, fallback: RGBA): RGBA => {
  if (color === undefined || color.intent === "default") return fallback
  if (color.intent !== "indexed") return color
  return (
    [
      colors.selectionFg,
      colors.red,
      colors.green,
      colors.amber,
      colors.blue,
      colors.purple,
      colors.teal,
      colors.text,
      colors.muted,
    ][color.slot] ?? color
  )
}

export function StyledChunks(props: { readonly content: StyledText }) {
  return (
    <For each={props.content.chunks}>
      {(chunk) => (
        <span
          style={{
            fg: referenceColor(chunk.fg, colors.text),
            bg: referenceColor(chunk.bg, colors.surface),
            bold: ((chunk.attributes ?? 0) & TextAttributes.BOLD) !== 0,
            dim: ((chunk.attributes ?? 0) & TextAttributes.DIM) !== 0,
            italic: ((chunk.attributes ?? 0) & TextAttributes.ITALIC) !== 0,
            underline: ((chunk.attributes ?? 0) & TextAttributes.UNDERLINE) !== 0,
            strikethrough: ((chunk.attributes ?? 0) & TextAttributes.STRIKETHROUGH) !== 0,
          }}
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
