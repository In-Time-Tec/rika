import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product-store/sqlite-turn-repository"
import { Effect, Function } from "effect"

export const executionRoute = () => Turn.testExecutionRoute()

type CreateInput = Omit<TurnRepository.CreateInput, "author" | "executionRoute" | "lineage" | "queueCapacity"> & {
  readonly author?: Turn.TurnAuthor
  readonly executionRoute?: Turn.ExecutionRoutePin
  readonly lineage?: Turn.TurnLineage
}

export const createTurn: {
  (
    input: CreateInput,
  ): (
    repository: TurnRepository.Interface,
  ) => Effect.Effect<TurnRepository.Submission, TurnRepository.QueueFull | TurnRepository.RepositoryError>
  (
    repository: TurnRepository.Interface,
    input: CreateInput,
  ): Effect.Effect<TurnRepository.Submission, TurnRepository.QueueFull | TurnRepository.RepositoryError>
} = Function.dual(2, (repository: TurnRepository.Interface, input: CreateInput) =>
  repository.createForSubmission({
    author: { _tag: "Human" },
    executionRoute: executionRoute(),
    lineage: { _tag: "Original" },
    queueCapacity: 128,
    ...input,
  }),
)
