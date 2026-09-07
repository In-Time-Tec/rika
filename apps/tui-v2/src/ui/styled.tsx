import type { RGBA, TextRenderable } from "@opentui/core"
import { StyledText, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, createContext, createEffect, createMemo, useContext, type Accessor } from "solid-js"
import { colors } from "./theme"

export const TranscriptWidth = createContext<Accessor<number>>()

const referencePalette = [
  colors.selectionFg,
  colors.red,
  colors.green,
  colors.amber,
  colors.blue,
  colors.purple,
  colors.teal,
  colors.text,
  colors.muted,
] as const

const referenceColor = (color: RGBA | undefined, fallback: RGBA): RGBA => {
  if (color === undefined || color.intent === "default") return fallback
  if (color.intent !== "indexed") return color
  return referencePalette[color.slot] ?? color
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
  let text: TextRenderable | undefined
  let width = useContext(TranscriptWidth)
  if (width === undefined) {
    const dimensions = useTerminalDimensions()
    width = () => dimensions().width
  }
  const availableWidth = width
  const content = createMemo(
    () =>
      new StyledText(
        props.render(Math.max(8, availableWidth() - 4)).chunks.map((chunk) => ({
          ...chunk,
          fg: referenceColor(chunk.fg, colors.text),
          bg: referenceColor(chunk.bg, colors.surface),
        })),
      ),
  )
  createEffect(() => {
    const next = content()
    if (text !== undefined && text.content !== next) text.content = next
  })
  return (
    <text
      ref={(node) => {
        text = node
        text.content = content()
      }}
      width="100%"
      wrapMode="none"
      selectable
      selectionBg={colors.selectionBg}
      selectionFg={colors.selectionFg}
    />
  )
}
