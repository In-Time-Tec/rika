import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { identityKey } from "@rika/transcript/transcript-unit-identity"
import type * as Turn from "@rika/product/turn-record"

export const promptUnit = (turn: Pick<Turn.Turn, "id" | "prompt">): TranscriptUnit.Unit => {
  const key = identityKey("turn", turn.id, "user")
  return {
    key,
    turnId: String(turn.id),
    order: [{ sequence: -1, part: 0, key }],
    revision: 0,
    content: { _tag: "Entry", role: "user", text: turn.prompt },
  }
}
