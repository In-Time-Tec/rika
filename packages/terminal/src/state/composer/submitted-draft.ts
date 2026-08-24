import { Function } from "effect"
import type { ComposerDraft } from "./model"

interface SubmittedDraft extends ComposerDraft {
  readonly cursor: number
  readonly submissionId?: string
  readonly turnId?: string
}
export type { SubmittedDraft }

const bindSubmittedDraftImpl = (
  drafts: ReadonlyArray<SubmittedDraft>,
  turnId: string,
  submissionId?: string,
): ReadonlyArray<SubmittedDraft> => {
  if (drafts.some((draft) => draft.turnId === turnId)) return drafts
  const index =
    submissionId === undefined
      ? drafts.findIndex((draft) => draft.turnId === undefined)
      : drafts.findIndex((draft) => draft.submissionId === submissionId && draft.turnId === undefined)
  if (index < 0) return drafts
  return drafts.map((draft, position) => (position === index ? { ...draft, turnId } : draft))
}

export const bindSubmittedDraft: {
  (
    arg0: Parameters<typeof bindSubmittedDraftImpl>[0],
    arg1: Parameters<typeof bindSubmittedDraftImpl>[1],
    arg2?: Parameters<typeof bindSubmittedDraftImpl>[2],
  ): ReturnType<typeof bindSubmittedDraftImpl>
  (
    arg1: Parameters<typeof bindSubmittedDraftImpl>[1],
    arg2?: Parameters<typeof bindSubmittedDraftImpl>[2],
  ): (arg0: Parameters<typeof bindSubmittedDraftImpl>[0]) => ReturnType<typeof bindSubmittedDraftImpl>
} = Function.dual((args) => Array.isArray(args[0]), bindSubmittedDraftImpl)

const dropSubmittedDraftsImpl = (
  drafts: ReadonlyArray<SubmittedDraft>,
  turnId: string | undefined,
): ReadonlyArray<SubmittedDraft> => (turnId === undefined ? [] : drafts.filter((draft) => draft.turnId !== turnId))

export const dropSubmittedDrafts: {
  (
    arg1: Parameters<typeof dropSubmittedDraftsImpl>[1],
  ): (arg0: Parameters<typeof dropSubmittedDraftsImpl>[0]) => ReturnType<typeof dropSubmittedDraftsImpl>
  (
    arg0: Parameters<typeof dropSubmittedDraftsImpl>[0],
    arg1: Parameters<typeof dropSubmittedDraftsImpl>[1],
  ): ReturnType<typeof dropSubmittedDraftsImpl>
} = Function.dual(2, dropSubmittedDraftsImpl)

const takeSubmittedDraftImpl = (
  drafts: ReadonlyArray<SubmittedDraft>,
  turnId: string | undefined,
): { readonly draft: SubmittedDraft | undefined; readonly rest: ReadonlyArray<SubmittedDraft> } => {
  const index = drafts.findIndex((draft) => turnId === undefined || draft.turnId === turnId)
  if (index < 0) return { draft: undefined, rest: drafts }
  return { draft: drafts[index], rest: drafts.filter((_, position) => position !== index) }
}

export const takeSubmittedDraft: {
  (
    arg1: Parameters<typeof takeSubmittedDraftImpl>[1],
  ): (arg0: Parameters<typeof takeSubmittedDraftImpl>[0]) => ReturnType<typeof takeSubmittedDraftImpl>
  (
    arg0: Parameters<typeof takeSubmittedDraftImpl>[0],
    arg1: Parameters<typeof takeSubmittedDraftImpl>[1],
  ): ReturnType<typeof takeSubmittedDraftImpl>
} = Function.dual(2, takeSubmittedDraftImpl)

const takeSubmittedDraftForImpl = (
  drafts: ReadonlyArray<SubmittedDraft>,
  reference: { readonly turnId?: string; readonly submissionId?: string },
): { readonly draft: SubmittedDraft | undefined; readonly rest: ReadonlyArray<SubmittedDraft> } => {
  const index = drafts.findIndex((draft) => {
    if (reference.submissionId !== undefined) return draft.submissionId === reference.submissionId
    if (reference.turnId !== undefined) return draft.turnId === reference.turnId
    return draft.turnId === undefined
  })
  if (index < 0) return { draft: undefined, rest: drafts }
  return { draft: drafts[index], rest: drafts.filter((_, position) => position !== index) }
}

export const takeSubmittedDraftFor: {
  (
    arg1: Parameters<typeof takeSubmittedDraftForImpl>[1],
  ): (arg0: Parameters<typeof takeSubmittedDraftForImpl>[0]) => ReturnType<typeof takeSubmittedDraftForImpl>
  (
    arg0: Parameters<typeof takeSubmittedDraftForImpl>[0],
    arg1: Parameters<typeof takeSubmittedDraftForImpl>[1],
  ): ReturnType<typeof takeSubmittedDraftForImpl>
} = Function.dual(2, takeSubmittedDraftForImpl)
