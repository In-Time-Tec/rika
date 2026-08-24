import type { Mode } from "@rika/terminal/terminal-state"
import { promptParts, type Action } from "@rika/terminal/terminal-session"

const initialSubmitActionImpl = (
  prompt: ReadonlyArray<string>,
  mode: Mode,
): Extract<Action, { readonly _tag: "Submit" }> | undefined => {
  if (prompt.length === 0) return undefined
  const value = prompt.join(" ")
  return { _tag: "Submit", prompt: value, parts: promptParts(value), mode }
}

export const initialSubmitAction: {
  (mode: Mode): (prompt: ReadonlyArray<string>) => ReturnType<typeof initialSubmitActionImpl>
  (prompt: ReadonlyArray<string>, mode: Mode): ReturnType<typeof initialSubmitActionImpl>
} = ((first: ReadonlyArray<string> | Mode, second?: Mode | ReadonlyArray<string>) => {
  if (Array.isArray(first)) return initialSubmitActionImpl(first, second as Mode)
  return (prompt: ReadonlyArray<string>) => initialSubmitActionImpl(prompt, first as Mode)
}) as typeof initialSubmitAction
