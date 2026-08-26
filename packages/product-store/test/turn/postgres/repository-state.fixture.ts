import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ThreadRelationship from "@rika/product/thread-relationship"
import { Effect, Function } from "effect"

export const executionRoute = () => ExecutionRouteSnapshot.testExecutionRoute()

type CreateInput = Omit<
  Parameters<TurnRepository.Interface["createForSubmission"]>[0],
  "author" | "executionRoute" | "lineage" | "queueCapacity"
> & {
  readonly author?: ThreadRelationship.TurnAuthor
  readonly executionRoute?: ExecutionRouteSnapshot.ExecutionRouteSnapshot
  readonly lineage?: ThreadRelationship.TurnLineage
}

export const createTurn: {
  (
    input: CreateInput,
  ): (
    repository: TurnRepository.Interface,
  ) => Effect.Effect<
    Effect.Success<ReturnType<TurnRepository.Interface["createForSubmission"]>>,
    TurnRepository.QueueFull | TurnRepository.RepositoryError
  >
  (
    repository: TurnRepository.Interface,
    input: CreateInput,
  ): Effect.Effect<
    Effect.Success<ReturnType<TurnRepository.Interface["createForSubmission"]>>,
    TurnRepository.QueueFull | TurnRepository.RepositoryError
  >
} = Function.dual(2, (repository: TurnRepository.Interface, input: CreateInput) =>
  repository.createForSubmission({
    author: { _tag: "Human" },
    executionRoute: executionRoute(),
    lineage: { _tag: "Original" },
    queueCapacity: 128,
    ...input,
  }),
)
