import { OperationError } from "../operation-error"
import { Function } from "effect"
import { Effect } from "effect"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TurnRepositoryContract from "../../thread/repository/turn-repository-contract"

export const admitInteractiveTurn = (input: {
  readonly turns: TurnRepository.Interface
  readonly submission: TurnRepositoryContract.CreateInput
  readonly claim: (
    turnId: Turn.TurnId,
    status?: ExecutionStatus.Status,
  ) => Effect.Effect<boolean, OperationError, never>
}) =>
  Effect.gen(function* () {
    const turn = yield* input.turns.createForSubmission(input.submission)
    if (turn.status === "queued") return { turn, claimed: false }
    return { turn, claimed: yield* input.claim(turn.id, turn.status) }
  })

const newThreadTitleImpl = (prompt: string, fallback: string): string => {
  const title = prompt.split(/\r?\n/, 1)[0]?.trim() ?? ""
  return title.length === 0 ? fallback : title
}

export const newThreadTitle: {
  (arg1: string): (arg0: string) => ReturnType<typeof newThreadTitleImpl>
  (arg0: string, arg1: string): ReturnType<typeof newThreadTitleImpl>
} = Function.dual(2, newThreadTitleImpl)
