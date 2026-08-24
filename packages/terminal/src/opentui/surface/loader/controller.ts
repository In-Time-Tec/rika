import type { Clock as OpenTuiClock, TimerHandle } from "@opentui/core"

export interface LoaderHost {
  readonly clock: OpenTuiClock
}

export class LoaderController {
  public phase = 0
  public publishedFrame: string | undefined
  public published = false
  private timer: TimerHandle | undefined

  constructor(private readonly host: LoaderHost) {}

  get running(): boolean {
    return this.timer !== undefined
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
