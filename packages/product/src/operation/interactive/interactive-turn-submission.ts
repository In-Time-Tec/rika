import { Effect } from "effect"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TurnRepositoryContract from "../../thread/repository/turn-repository-contract"

export const admitInteractiveTurn = (input: {
  readonly turns: TurnRepository.Interface
  readonly submission: TurnRepositoryContract.CreateInput
}) =>
  Effect.gen(function* () {
    const turn = yield* input.turns.createForSubmission(input.submission)
    return { turn, claimed: false }
  })
