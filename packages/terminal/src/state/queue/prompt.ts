import { Function } from "effect"
import type { Model } from "../model"

export const replaceTurnPrompt: {
  (model: Model, turnId: string, prompt: string): Model
  (turnId: string, prompt: string): (model: Model) => Model
} = Function.dual(3, (model: Model, turnId: string, prompt: string): Model => {
  const index = model.entries.findIndex((entry) => entry.role === "user" && entry.turnId === turnId)
  if (index < 0) return model
  const entries = [...model.entries]
  entries[index] = { ...entries[index]!, text: prompt }
  return { ...model, entries }
})
