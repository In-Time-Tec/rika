import type { Mode } from "@rika/terminal/terminal-state"
import { promptParts, type Action } from "@rika/terminal/terminal-session"
import { Schema } from "effect"

const initialSubmitActionImpl = (
  prompt: ReadonlyArray<string>,
  mode: Mode,
): Extract<Action, { readonly _tag: "Submit" }> | undefined => {
  if (prompt.length === 0) return undefined
  const value = prompt.join(" ")
  return { _tag: "Submit", prompt: value, parts: promptParts(value), mode }
}

export function initialSubmitAction(
  mode: Mode,
): (prompt: ReadonlyArray<string>) => ReturnType<typeof initialSubmitActionImpl>
export function initialSubmitAction(
  prompt: ReadonlyArray<string>,
  mode: Mode,
): ReturnType<typeof initialSubmitActionImpl>
export function initialSubmitAction(first: ReadonlyArray<string> | Mode, second?: Mode) {
  if (!Schema.is(Schema.String)(first)) return second === undefined ? undefined : initialSubmitActionImpl(first, second)
  return (prompt: ReadonlyArray<string>) => initialSubmitActionImpl(prompt, first)
}
