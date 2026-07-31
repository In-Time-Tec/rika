import { Effect } from "effect"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"

export const admitInteractiveTurn = (input: {
  readonly turns: TurnRepository.Interface
  readonly submission: TurnRepository.CreateInput
  readonly claim: (turnId: Turn.TurnId, status?: Turn.Status) => Effect.Effect<boolean, any, any>
}) =>
  Effect.gen(function* () {
    const turn = yield* input.turns.createForSubmission(input.submission)
    if (turn.status === "queued") return { turn, claimed: false }
    return { turn, claimed: yield* input.claim(turn.id, turn.status) }
  })

export const newThreadTitle = (prompt: string, fallback: string): string => {
  const title = prompt.split(/\r?\n/, 1)[0]?.trim() ?? ""
  return title.length === 0 ? fallback : title
}
