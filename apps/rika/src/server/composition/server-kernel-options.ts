import type * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import type * as GoalRepository from "@rika/product/goal-repository"
import type * as ThreadQuery from "@rika/product/thread-query-service"
import type { Layer } from "effect"

export interface Options {
  readonly workspace: string
  readonly home: string
  readonly dataRoot: string
  readonly runtimeVersion: string
  readonly goalRepositoryLayer: Layer.Layer<GoalRepository.Service>
  readonly queryFactory: Layer.Layer<ThreadQuery.Factory>
  readonly toolRuntimeLayer: Layer.Layer<CodingToolRuntime.Service>
}
