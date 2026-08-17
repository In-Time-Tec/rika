import type { TextRenderable } from "@opentui/core"
import { orbGeometry, orbImpulseExpired, type OrbImpulse } from "./opentui-welcome-orb"
import { spacing } from "../../presentation/terminal/terminal-theme"

const inputReserve = spacing.inputHeight

/**
 * The orb's phase is derived from elapsed time like every other animation. Only the mouse-strike
 * impulses are genuinely stateful, so this holds those and nothing else.
 */
export class WelcomeController {
  public child: TextRenderable | undefined
  public key = ""
  public impulses: ReadonlyArray<OrbImpulse> = []

  strike(width: number, height: number, x: number, y: number, phase: number): void {
    const geometry = orbGeometry(width, height)
    const top = Math.max(0, Math.floor((Math.max(1, height - inputReserve) - geometry.rows) / 2))
    const left = Math.max(0, Math.floor(width / 2) - geometry.columns - 2)
    this.impulses = [...this.impulses, { column: x - left, row: y - top, startPhase: phase }]
  }

  expire(phase: number): void {
    this.impulses = this.impulses.filter((impulse) => !orbImpulseExpired(impulse, phase))
  }

  clear(): void {
    this.child = undefined
    this.impulses = []
  }

  release(): void {
    this.child = undefined
  }
}
