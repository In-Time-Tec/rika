import { decodePasteBytes, stripAnsiSequences, type PasteEvent, type TextareaRenderable } from "@opentui/core"
import { composerEdit } from "@rika/terminal/terminal-composer-edit"
import { displayInput, expandPastedText } from "@rika/terminal/terminal-session"
import { initial, type Model } from "@rika/terminal/terminal-state"
import { Clock, Effect, Function } from "effect"
import { createSignal, type Accessor, type Setter } from "solid-js"
import type { ImageAttachment } from "../../client/model"
import type { DraftAttachment, DraftAttachments, Drafts } from "../types"

const replaceLabels = (input: string, attachments: readonly DraftAttachment[]): string =>
  attachments.reduce((value, attachment) => value.replaceAll(attachment.label, attachment.token), input)

const composerWorkspace = (workspace: Accessor<string>): string =>
  workspace().length === 0 ? process.cwd() : workspace()

export interface DraftController {
  readonly drafts: Accessor<Drafts>
  readonly setDrafts: Setter<Drafts>
  readonly draftAttachments: Accessor<DraftAttachments>
  readonly setAttachmentsFor: (id: string, attachments: readonly DraftAttachment[]) => void
  readonly updateDraft: (id: string, value: string) => void
  readonly expandDraft: (id: string, input: string) => string
  readonly imagesFor: (id: string) => readonly ImageAttachment[]
  readonly handlePaste: (event: Pick<PasteEvent, "bytes" | "metadata">, editor: TextareaRenderable) => boolean
}

const createDraftsImpl = (
  selectedId: Accessor<string>,
  editingId: Accessor<string | undefined>,
  workspace: Accessor<string>,
): DraftController => {
  const [drafts, setDrafts] = createSignal<Drafts>({})
  const [draftAttachments, setDraftAttachments] = createSignal<DraftAttachments>({})
  let lastPaste: { readonly text: string; readonly at: number } | undefined
  let imageSequence = 0
  const setAttachmentsFor = (id: string, attachments: readonly DraftAttachment[]) =>
    setDraftAttachments((previous) => ({ ...previous, [id]: attachments }))
  const updateDraft = (id: string, value: string) => {
    setDrafts((previous) => ({ ...previous, [id]: value }))
    setDraftAttachments((previous) => ({
      ...previous,
      [id]: (previous[id] ?? []).filter((attachment) => value.includes(attachment.label)),
    }))
  }
  const imagesFor = (id: string): readonly ImageAttachment[] =>
    (draftAttachments()[id] ?? []).flatMap((attachment) => {
      if (attachment.type !== "image") return []
      const image: ImageAttachment = { path: attachment.path }
      if (attachment.mediaType !== undefined) Object.assign(image, { mediaType: attachment.mediaType })
      if (attachment.byteLength !== undefined) Object.assign(image, { byteLength: attachment.byteLength })
      return [image]
    })
  const expandDraft = (id: string, input: string): string => {
    const attachments = draftAttachments()[id] ?? []
    const canonical = replaceLabels(input, attachments)
    const withoutImages = attachments.reduce(
      (text, attachment) => (attachment.type === "image" ? text.replaceAll(attachment.token, "") : text),
      canonical,
    )
    return expandPastedText(withoutImages, attachments)
  }
  const sync = (
    editor: TextareaRenderable,
    model: Model,
    id: string,
    attachments: readonly DraftAttachment[] = model.pastedText,
  ) => {
    const display = displayInput(model)
    editor.setText(display)
    editor.cursorOffset = displayInput({ ...model, input: model.input.slice(0, model.cursor) }).length
    setDrafts((previous) => ({ ...previous, [id]: display }))
    setAttachmentsFor(id, attachments)
  }
  const handlePaste = (event: Pick<PasteEvent, "bytes" | "metadata">, editor: TextareaRenderable): boolean => {
    const id = selectedId(),
      attachments = draftAttachments()[id] ?? []
    const base: Model = {
      ...initial(composerWorkspace(workspace)),
      input: replaceLabels(editor.plainText, attachments),
      cursor: replaceLabels(editor.plainText.slice(0, editor.cursorOffset), attachments).length,
      pastedText: attachments,
      editingTurnId: editingId(),
    }
    const mediaType = event.metadata?.mimeType?.toLowerCase()
    if (mediaType?.startsWith("image/") === true) {
      if (editingId() !== undefined) return true
      imageSequence += 1
      const extension = mediaType.slice(6).replace(/[^a-z0-9]/g, "")
      const next = composerEdit.insertImage(base, `clipboard-${imageSequence}.${extension}`)
      const added = next.pastedText.at(-1)
      const metadata = next.pastedText.map((attachment) =>
        attachment === added ? { ...attachment, mediaType, byteLength: event.bytes.byteLength } : attachment,
      )
      sync(editor, next, id, metadata)
      lastPaste = undefined
      return true
    }
    if (event.metadata?.kind === "binary") {
      editor.insertText(`[Unsupported clipboard data: ${mediaType ?? "binary"}]`)
      return true
    }
    const text = stripAnsiSequences(decodePasteBytes(event.bytes))
    if (text.length === 0) return true
    const now = Effect.runSync(Clock.currentTimeMillis)
    if (lastPaste?.text === text && now - lastPaste.at < 500) {
      const attachment = attachments.find((candidate) => candidate.type === "text" && candidate.value === text)
      if (attachment !== undefined) {
        sync(editor, composerEdit.expandPastedTextAttachment(base, attachment.token), id)
        lastPaste = undefined
        return true
      }
    }
    lastPaste = { text, at: now }
    sync(editor, composerEdit.insertPaste(base, text), id)
    return true
  }
  return { drafts, setDrafts, draftAttachments, setAttachmentsFor, updateDraft, expandDraft, imagesFor, handlePaste }
}
export const createDrafts: {
  (editingId: Accessor<string | undefined>, workspace: Accessor<string>): (selectedId: Accessor<string>) => DraftController
  (selectedId: Accessor<string>, editingId: Accessor<string | undefined>, workspace: Accessor<string>): DraftController
} = Function.dual(3, createDraftsImpl)
