import { Function } from "effect"
import type { Mode } from "../model"

const nextModeImpl = (mode: Mode, modes: ReadonlyArray<Mode>): Mode => {
  if (modes.length === 0) return mode
  return modes[(modes.indexOf(mode) + 1) % modes.length]!
}
export const nextMode: {
  (modes: ReadonlyArray<Mode>): (mode: Mode) => Mode
  (mode: Mode, modes: ReadonlyArray<Mode>): Mode
} = Function.dual(2, nextModeImpl)
