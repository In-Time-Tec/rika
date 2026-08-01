import { Function } from "effect"
import type { ComposerAttachment } from "./terminal-composer-state"
import type { Model } from "./terminal-state"

export const expandPastedText: {
  (input: string, pastedText: ReadonlyArray<ComposerAttachment>): string
  (pastedText: ReadonlyArray<ComposerAttachment>): (input: string) => string
} = Function.dual(2, (input: string, pastedText: ReadonlyArray<ComposerAttachment>): string =>
  pastedText.reduce(
    (text, attachment) =>
      text.replaceAll(attachment.token, attachment.type === "image" ? attachment.label : attachment.value),
    input,
  ),
)

export const pastedTextTokenAt: {
  (model: Model, displayOffset: number): string | undefined
  (displayOffset: number): (model: Model) => string | undefined
} = Function.dual(2, (model: Model, displayOffset: number): string | undefined => {
  let offset = 0
  for (const part of model.input.split(/([\uE000-\uF8FF])/u)) {
    const attachment = model.pastedText.find((candidate) => candidate.token === part)
    const width = attachment?.label.length ?? part.length
    if (attachment !== undefined && displayOffset >= offset && displayOffset < offset + width) return attachment.token
    offset += width
  }
  return undefined
})
