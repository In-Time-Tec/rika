import { dual } from "effect/Function"
import { StyledText, dim, fg, type Clock as OpenTuiClock, type TimerHandle } from "@opentui/core"
import { goalFrames } from "../rendering/opentui-spinner"
import { colors } from "../../presentation/terminal/terminal-theme"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import { formatGoalElapsed } from "../../state/model/terminal-goal"

export interface GoalHost {
  readonly clock: OpenTuiClock
}

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

/**
 * The goal icon's own timer, independent of the loader and the welcome orb. It exists only while a
 * goal is active, so an idle Rika with no goal runs no interval and forces no frame.
 */
export class GoalController {
  public phase = 0
  private timer: TimerHandle | undefined

  constructor(private readonly host: GoalHost) {}

  get running(): boolean {
    return this.timer !== undefined
  }

  get frame(): string {
    return goalFrames[this.phase % goalFrames.length]!
  }

  start(interval: number, tick: () => void): void {
    if (this.timer !== undefined) return
    this.timer = this.host.clock.setInterval(tick, interval)
  }

  stop(): void {
    if (this.timer === undefined) return
    this.host.clock.clearInterval(this.timer)
    this.timer = undefined
  }

  advance(): number {
    this.phase += 1
    return this.phase
  }

  release(): void {
    this.stop()
  }
}
