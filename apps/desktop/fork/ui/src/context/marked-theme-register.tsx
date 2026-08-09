import { registerCustomTheme } from "@pierre/diffs"
import { RikaTheme } from "./marked-theme"

let registered = false

export function registerRikaTheme() {
  if (registered) return
  registered = true
  registerCustomTheme("Rika", () => Promise.resolve(RikaTheme))
}
