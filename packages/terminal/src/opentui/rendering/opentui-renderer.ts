import { fg, StyledText, type TextChunk } from "@opentui/core"
import { Function } from "effect"
import type { Model } from "../../state/model/terminal-state"
import { colors } from "../../presentation/terminal/terminal-theme"
import { toOpenColor } from "./terminal-text-adapter"
import { orderedTranscriptItems, transcriptUnits } from "../../presentation/transcript/transcript-row"
import { offsetUnitRange } from "./opentui-render-transcript-window"
import { transcriptUnitBuilder } from "./opentui-render-unit"
import { idleSpinnerFrame } from "./opentui-spinner"
import type { UnitLineRange } from "./opentui-render-transcript-window"
export const buildTranscript: {
  (model: Model, spinnerFrame?: string): { styled: StyledText; ranges: ReadonlyArray<UnitLineRange> }
  (spinnerFrame?: string): (model: Model) => { styled: StyledText; ranges: ReadonlyArray<UnitLineRange> }
} = Function.dual(
  (args) => typeof args[0] !== "string",
  (model: Model, spinnerFrame = idleSpinnerFrame): { styled: StyledText; ranges: ReadonlyArray<UnitLineRange> } => {
    const builder = transcriptUnitBuilder(model, spinnerFrame)
    const chunks: Array<TextChunk> = []
    const ranges: Array<UnitLineRange> = []
    let line = 0
    const append = (chunk: TextChunk) => {
      chunks.push(chunk)
      line += chunk.text.split("\n").length - 1
    }
    let renderedUnits = 0
    if (orderedTranscriptItems(model)[0]?._tag === "Block") append(fg(colors.text)("\n"))
    for (const unit of transcriptUnits(model)) {
      if (!builder.isUnitVisible(unit)) continue
      if (renderedUnits > 0) append(fg(colors.text)("\n\n"))
      renderedUnits += 1
      const built = builder.renderUnit(unit)
      const offset = line
      for (const chunk of built.chunks) chunks.push(chunk)
      line += built.lines
      ranges.push({ ...offsetUnitRange(built.root, offset), gapBefore: renderedUnits > 1 })
      for (const nested of built.nested) ranges.push(offsetUnitRange(nested, offset))
    }
    return { styled: new StyledText(chunks), ranges }
  },
)

export const renderTranscriptStyled = (model: Model): StyledText => {
  const styled = buildTranscript(model).styled
  return new StyledText(
    styled.chunks.map((chunk) =>
      chunk.fg === undefined ? chunk : Object.assign({}, chunk, { fg: toOpenColor(chunk.fg) }),
    ),
  )
}
