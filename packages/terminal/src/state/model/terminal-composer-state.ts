import { Function } from "effect"
import type { Model } from "./terminal-state"

export type PromptPart =
  | { readonly type: "text"; readonly text: string; readonly pasted?: boolean }
  | { readonly type: "image"; readonly path: string }

export type ComposerAttachment =
  | { readonly type: "text"; readonly token: string; readonly value: string; readonly label: string }
  | { readonly type: "image"; readonly token: string; readonly path: string; readonly label: string }

export interface ComposerDraft {
  readonly input: string
  readonly attachments: ReadonlyArray<ComposerAttachment>
}

export interface PendingSteering {
  readonly turnId: string
  readonly text: string
  readonly sequence?: number
}

export type PromptSubmission =
  | { readonly _tag: "Prompt"; readonly prompt: string }
  | { readonly _tag: "Shell"; readonly command: string; readonly incognito: boolean }

export const classifyPrompt = (input: string): PromptSubmission => {
  if (input.startsWith("$$")) return { _tag: "Shell", command: input.slice(2).trimStart(), incognito: true }
  if (input.startsWith("$")) return { _tag: "Shell", command: input.slice(1).trimStart(), incognito: false }
  return { _tag: "Prompt", prompt: input }
}

const imagePathPattern =
  /@image:(?:"([^"]+\.(?:png|jpe?g|gif|webp))"|'([^']+\.(?:png|jpe?g|gif|webp))'|([^\s,;]+\.(?:png|jpe?g|gif|webp)))|\[([^\]\n]+\.(?:png|jpe?g|gif|webp))\]|(?:file:\/\/[^\s]+\.(?:png|jpe?g|gif|webp))|(?:(?:\\ |[^\s[\]])+\.(?:png|jpe?g|gif|webp))/gi
const textPart = (text: string, pasted: boolean): PromptPart =>
  pasted ? { type: "text", text, pasted } : { type: "text", text }
const appendPromptPart = (parts: Array<PromptPart>, part: PromptPart): void => {
  const previous = parts.at(-1)
  if (part.type === "text" && previous?.type === "text" && (previous.pasted ?? false) === (part.pasted ?? false)) {
    parts[parts.length - 1] = textPart(previous.text + part.text, part.pasted ?? false)
    return
  }
  parts.push(part)
}
const appendParsedText = (parts: Array<PromptPart>, text: string, pasted: boolean): void => {
  let offset = 0
  for (const match of text.matchAll(imagePathPattern)) {
    const index = match.index
    if (index > offset) appendPromptPart(parts, textPart(text.slice(offset, index), pasted))
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[0]
    let path = value
    if (path.startsWith("file://")) {
      try {
        path = decodeURIComponent(new URL(path).pathname)
      } catch {}
    }
    appendPromptPart(parts, { type: "image", path: path.replace(/\\ /g, " ") })
    offset = index + match[0].length
  }
  if (offset < text.length) appendPromptPart(parts, textPart(text.slice(offset), pasted))
}

export const promptParts: {
  (input: string, pastedText?: ReadonlyArray<ComposerAttachment>): ReadonlyArray<PromptPart>
  (pastedText?: ReadonlyArray<ComposerAttachment>): (input: string) => ReadonlyArray<PromptPart>
} = Function.dual(
  (args) => args.length > 1 || typeof args[0] === "string",
  (input: string, pastedText: ReadonlyArray<ComposerAttachment> = []): ReadonlyArray<PromptPart> => {
    const parts: Array<PromptPart> = []
    for (const value of input.split(/([\uE000-\uF8FF])/u)) {
      const attachment = pastedText.find((candidate) => candidate.token === value)
      if (attachment?.type === "image") appendPromptPart(parts, { type: "image", path: attachment.path })
      else if (attachment?.type === "text") appendParsedText(parts, attachment.value, true)
      else appendParsedText(parts, value, false)
    }
    return parts.length === 0 ? [{ type: "text", text: "" }] : parts
  },
)

export const displayInput = (model: Model): string =>
  model.pastedText.reduce((text, attachment) => text.replaceAll(attachment.token, attachment.label), model.input)

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
