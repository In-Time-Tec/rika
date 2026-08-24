import type { Model } from "../../../state/model"

export const welcomeVisible = (model: Model): boolean => model.entries.length === 0 && model.blocks.length === 0

export const welcomeAnimationActive = (model: Model): boolean => welcomeVisible(model) && model.height >= 20
