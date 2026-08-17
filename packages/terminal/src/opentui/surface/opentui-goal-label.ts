import { dual } from "effect/Function"
import { StyledText, dim, fg } from "@opentui/core"
import { colors } from "../../presentation/terminal/terminal-theme"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import { formatGoalElapsed } from "../../state/model/terminal-goal"

/** Mirrors the bottom-left status line, with the goal frame set in place of the loader frames. */
export const goalLabelContent: {
  (elapsedMillis: number): (frame: string) => StyledText
  (frame: string, elapsedMillis: number): StyledText
} = dual(
  2,
  (frame: string, elapsedMillis: number): StyledText =>
    new StyledText([
      fg(toOpenColor(colors.text))(" "),
      fg(toOpenColor(colors.blue))(frame),
      dim(fg(toOpenColor(colors.text))(` Goal ${formatGoalElapsed(elapsedMillis)} `)),
    ]),
)
