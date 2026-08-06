import { Function } from "effect"

export interface TranscriptContentChange {
  readonly prepended: ReadonlyArray<string>
  readonly appended: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
}

export const classifyTranscriptContent: {
  (
    current: ReadonlyArray<{ readonly id: string }>,
  ): (previous: ReadonlyArray<{ readonly id: string }>) => TranscriptContentChange
  (
    previous: ReadonlyArray<{ readonly id: string }>,
    current: ReadonlyArray<{ readonly id: string }>,
  ): TranscriptContentChange
} = Function.dual(
  2,
  (
    previous: ReadonlyArray<{ readonly id: string }>,
    current: ReadonlyArray<{ readonly id: string }>,
  ): TranscriptContentChange => {
    const previousIds = new Set(previous.map(({ id }) => id))
    const currentIds = new Set(current.map(({ id }) => id))
    const retained = current.findIndex(({ id }) => previousIds.has(id))
    const lastRetained = current.findLastIndex(({ id }) => previousIds.has(id))
    return {
      prepended: (retained < 0 ? [] : current.slice(0, retained)).map(({ id }) => id),
      appended: (lastRetained < 0 ? current : current.slice(lastRetained + 1)).map(({ id }) => id),
      removed: previous.filter(({ id }) => !currentIds.has(id)).map(({ id }) => id),
    }
  },
)
