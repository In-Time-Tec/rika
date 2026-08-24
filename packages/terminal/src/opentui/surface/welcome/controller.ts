import type { TextRenderable, Clock as OpenTuiClock, TimerHandle } from "@opentui/core"
import { orbGeometry, orbImpulseExpired, type OrbImpulse } from "./orb"
import { spacing } from "../../../presentation/terminal/theme"

const inputReserve = spacing.inputHeight

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

  strike(width: number, height: number, x: number, y: number): void {
    const geometry = orbGeometry(width, height)
    const top = Math.max(0, Math.floor((Math.max(1, height - inputReserve) - geometry.rows) / 2))
    const left = Math.max(0, Math.floor(width / 2) - geometry.columns - 2)
    this.impulses = [...this.impulses, { column: x - left, row: y - top, startPhase: this.phase }]
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
