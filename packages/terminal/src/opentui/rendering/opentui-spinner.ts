import { OptimizedBuffer } from "@opentui/core"
import cliSpinners from "cli-spinners"
import { Function } from "effect"

export const spinnerFrames: ReadonlyArray<string> = cliSpinners.dots.frames

export const probeNativeAsset = (): string => {
  const buffer = OptimizedBuffer.create(1, 1, "wcwidth")
  buffer.destroy()
  return "RIKA_OPENTUI_NATIVE_OK"
}

export const statusSpinnerFrames: ReadonlyArray<string> = ["∼", "≈", "≋", "≈", "∼"]
export const goalFrames: ReadonlyArray<string> = ["◜", "◝", "◞", "◟"]
const animationInterval = 100
export const spinnerInterval = animationInterval
export const idleSpinnerFrame = "⠭"

export class ToolSpinner {
  private state = [true, false, true, false, true, false, true, false]
  private previousState: ReadonlyArray<boolean> = []
  private generation = 0
  private readonly neighborMap = [
    [1, 3, 4, 5, 7],
    [0, 2, 4, 5, 6],
    [1, 3, 5, 6, 7],
    [0, 2, 4, 6, 7],
    [0, 1, 3, 5, 7],
    [0, 1, 2, 4, 6],
    [1, 2, 3, 5, 7],
    [0, 2, 3, 4, 6],
  ]

  constructor(private readonly random: () => number = Math.random) {}

  step(): void {
    const next = this.state.map((alive, index) => {
      const neighbors = this.neighborMap[index]!.filter((neighbor) => this.state[neighbor]).length
      return alive ? neighbors === 2 || neighbors === 3 : neighbors === 3 || neighbors === 6
    })
    const stable = next.every((alive, index) => alive === this.state[index])
    const repeats = this.previousState.length > 0 && next.every((alive, index) => alive === this.previousState[index])
    this.previousState = [...this.state]
    this.state = next
    this.generation += 1
    const live = next.filter(Boolean).length
    if (stable || repeats || this.generation >= 15 || live < 2) {
      let seeded: Array<boolean>
      do seeded = Array.from({ length: 8 }, () => this.random() > 0.6)
      while (seeded.filter(Boolean).length < 3)
      this.state = seeded
      this.previousState = []
      this.generation = 0
    }
  }

  toBraille(): string {
    const dots = [0, 1, 2, 6, 3, 4, 5, 7]
    let point = 0x2800
    for (const [index, alive] of this.state.entries()) if (alive) point |= 1 << dots[index]!
    return String.fromCharCode(point)
  }
}

export const loaderFrame: {
  (phase: string | undefined, frame: number): string
  (frame: number): (phase: string | undefined) => string
} = Function.dual(2, (phase: string | undefined, frame: number): string =>
  phase === undefined ? "" : statusSpinnerFrames[frame % statusSpinnerFrames.length]!,
)
