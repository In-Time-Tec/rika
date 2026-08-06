import type { TextRenderable, Clock as OpenTuiClock, TimerHandle } from "@opentui/core"
import { orbImpulseExpired, type OrbImpulse } from "./opentui-welcome-orb"

export interface WelcomeHost {
  readonly clock: OpenTuiClock
  readonly destroyed: () => boolean
}

export class WelcomeController {
  public child: TextRenderable | undefined
  public key = ""
  public phase = 0
  public impulses: ReadonlyArray<OrbImpulse> = []
  private timer: TimerHandle | undefined

  strike(column: number, row: number): void {
    this.impulses = [...this.impulses, { column, row, startPhase: this.phase }]
  }

  constructor(private readonly host: WelcomeHost) {}

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
    this.impulses = this.impulses.filter((impulse) => !orbImpulseExpired(impulse, this.phase))
    return this.phase
  }

  clear(): void {
    this.child = undefined
    this.impulses = []
  }

  release(): void {
    this.stop()
    this.child = undefined
  }
}
