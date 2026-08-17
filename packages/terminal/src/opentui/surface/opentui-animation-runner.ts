import type { Clock as OpenTuiClock, TimerHandle } from "@opentui/core"
import { animationIntervalMillis } from "../rendering/opentui-animation-frame"

/**
 * The surface's only animation timer. It owns elapsed time rather than a frame counter, so every
 * animated glyph is a pure function of `elapsedMillis()` and its own identity, and a late frame
 * corrects itself instead of permanently shifting the animation.
 *
 * Each frame schedules the next one, so a frame that reports it has nothing left to animate simply
 * stops the chain. Stopping preserves the elapsed reading, so animations resume where the eye
 * expects them rather than jumping back to their first frame.
 */
export class AnimationRunner {
  private timer: TimerHandle | undefined
  private active = false
  private resumedAtMillis = 0
  private accumulatedMillis = 0

  constructor(
    private readonly clock: OpenTuiClock,
    private readonly onFrame: () => boolean,
  ) {}

  get running(): boolean {
    return this.active
  }

  elapsedMillis(): number {
    return this.active ? this.accumulatedMillis + (this.clock.now() - this.resumedAtMillis) : this.accumulatedMillis
  }

  start(): void {
    if (this.active) return
    this.active = true
    this.resumedAtMillis = this.clock.now()
    this.schedule()
  }

  stop(): void {
    if (!this.active) return
    this.accumulatedMillis += this.clock.now() - this.resumedAtMillis
    this.active = false
    if (this.timer === undefined) return
    this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(): void {
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      if (!this.active) return
      if (this.onFrame()) this.schedule()
      else this.stop()
    }, animationIntervalMillis)
  }
}
