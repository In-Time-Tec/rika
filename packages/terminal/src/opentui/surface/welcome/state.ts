import { Function } from "effect"
import type { Model } from "../../../state/model"
import type { OrbImpulse } from "./orb"

const introFrames = 140

export const welcomeVisible = (model: Model): boolean => model.entries.length === 0 && model.blocks.length === 0

export const welcomeAnimationActive = (model: Model): boolean => welcomeVisible(model) && model.height >= 20

const welcomeAnimationSettledImpl = (phase: number, impulses: ReadonlyArray<OrbImpulse>): boolean =>
  phase >= introFrames && impulses.length === 0

export const welcomeAnimationSettled: {
  (phase: number, impulses: ReadonlyArray<OrbImpulse>): boolean
  (impulses: ReadonlyArray<OrbImpulse>): (phase: number) => boolean
} = Function.dual(2, welcomeAnimationSettledImpl)
