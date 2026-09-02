import type { Key } from "../../presentation/terminal/keymap"
import { logWarning } from "../../warning"
import type { Model } from "../model"
import type { ComposerAttachment } from "./model"

const insert = (model: Model, value: string): Model => ({
  ...model,
  input: model.input.slice(0, model.cursor) + value + model.input.slice(model.cursor),
  cursor: model.cursor + value.length,
  historyIndex: undefined,
  historyDraft: undefined,
})

const erase = (model: Model, length: number): Model => ({
  ...model,
  input: model.input.slice(0, Math.max(0, model.cursor - length)) + model.input.slice(model.cursor),
  cursor: Math.max(0, model.cursor - length),
})

const lastCharacterLength = (value: string): number => Array.from(value).at(-1)?.length ?? 0
const fileMention = (path: string): string => `@${/\s/u.test(path) ? `"${path}"` : path} `
const questionKey = (key: Key): boolean => !key.ctrl && !key.alt && !key.meta && key.sequence === "?"

const composerContext = (model: Model): boolean =>
  !model.threadSwitcher.open &&
  !model.threadSidebar.focused &&
  !model.paletteOpen &&
  !model.palette.open &&
  !model.modePicker.open &&
  !model.filePicker.open

const continueShortcutsAfterEdit = (before: Model, after: Model): Model => {
  const trigger = before.shortcutsTrigger
  if (trigger === undefined || before.input[trigger] !== "?" || !composerContext(after))
    return { ...after, shortcutsOpen: false, shortcutsTrigger: undefined }
  if (before.input === after.input) return { ...after, shortcutsOpen: true, shortcutsTrigger: trigger }
  let prefix = 0
  while (prefix < before.input.length && prefix < after.input.length && before.input[prefix] === after.input[prefix])
    prefix += 1
  let suffix = 0
  while (
    suffix < before.input.length - prefix &&
    suffix < after.input.length - prefix &&
    before.input[before.input.length - 1 - suffix] === after.input[after.input.length - 1 - suffix]
  )
    suffix += 1
  const oldEnd = before.input.length - suffix
  let nextTrigger = -1
  if (trigger < prefix) nextTrigger = trigger
  else if (trigger >= oldEnd) nextTrigger = trigger + after.input.length - before.input.length
  return nextTrigger >= 0 && after.input[nextTrigger] === "?"
    ? { ...after, shortcutsOpen: true, shortcutsTrigger: nextTrigger }
    : { ...after, shortcutsOpen: false, shortcutsTrigger: undefined }
}

const insertWhileShortcutsOpen = (model: Model, value: string): Model => {
  const trigger = model.shortcutsTrigger
  const next = insert(model, value)
  return trigger === undefined
    ? next
    : { ...next, shortcutsTrigger: model.cursor <= trigger ? trigger + value.length : trigger }
}

const pastedImagePath = (value: string): string | undefined => {
  const trimmed = value.trim()
  const quoted = (/^'.*'$/s.test(trimmed) || /^".*"$/s.test(trimmed)) && trimmed.length >= 2
  const unquoted = quoted ? trimmed.slice(1, -1) : trimmed
  const pathLike =
    quoted || /^(?:file:\/\/|~\/|\.{0,2}\/|\/)/i.test(unquoted) || unquoted.includes("\\ ") || !/\s/.test(unquoted)
  if (!pathLike || !/\.(?:png|jpe?g|gif|webp)$/i.test(unquoted)) return undefined
  if (unquoted.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(unquoted).pathname)
    } catch (cause) {
      logWarning("tui.composer.pasted_image_url.invalid", cause)
    }
  }
  return unquoted.replace(/\\ /g, " ")
}

const pastedMention = /(?:^|\s)@[^\s,;]/

const insertPaste = (model: Model, value: string): Model => {
  const imagePath = pastedImagePath(value)
  if (imagePath !== undefined) return insertImage(model, imagePath)
  if (!value.includes("\n") && !value.includes("\r") && !pastedMention.test(value) && [...value].length <= 120)
    return insert(model, value)
  const token = String.fromCharCode(0xe000 + model.pastedText.length)
  const lines = value.split(/\r\n|\r|\n/).length
  const label =
    lines > 1
      ? `[Pasted text #${model.pastedText.length + 1} +${lines} lines]`
      : `[Pasted text #${model.pastedText.length + 1}]`
  const next = insert(model, token)
  return { ...next, pastedText: [...model.pastedText, { type: "text", token, value, label }] }
}

const insertImage = (model: Model, path: string): Model => {
  if (model.editingTurnId !== undefined) return model
  const token = String.fromCharCode(0xe000 + model.pastedText.length)
  const imageCount = model.pastedText.filter((attachment) => attachment.type === "image").length
  const next = insert(model, token)
  return {
    ...next,
    pastedText: [...model.pastedText, { type: "image", token, path, label: `[Image #${imageCount + 1}]` }],
  }
}

const removeImage = (model: Model, path: string): Model => {
  const attachment = model.pastedText.find(
    (candidate): candidate is Extract<ComposerAttachment, { readonly type: "image" }> =>
      candidate.type === "image" && candidate.path === path,
  )
  if (attachment === undefined) return model
  const offset = model.input.indexOf(attachment.token)
  return {
    ...model,
    input: model.input.replace(attachment.token, ""),
    cursor: offset >= 0 && model.cursor > offset ? model.cursor - attachment.token.length : model.cursor,
    pastedText: model.pastedText.filter((candidate) => candidate !== attachment),
  }
}

const expandPastedTextAttachment = (model: Model, token: string): Model => {
  const attachment = model.pastedText.find((candidate) => candidate.token === token)
  const tokenOffset = model.input.indexOf(token)
  if (attachment === undefined || attachment.type === "image" || tokenOffset < 0) return model
  return {
    ...model,
    input: model.input.replace(token, attachment.value),
    cursor: model.cursor > tokenOffset ? model.cursor + attachment.value.length - token.length : model.cursor,
    pastedText: model.pastedText.filter((candidate) => candidate.token !== token),
  }
}

export const composerEdit = {
  continueShortcutsAfterEdit,
  erase,
  expandPastedTextAttachment,
  fileMention,
  insert,
  insertImage,
  insertPaste,
  insertWhileShortcutsOpen,
  lastCharacterLength,
  questionKey,
  removeImage,
}
