import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ResolvedContext from "../../context/context-resolution-service"
import * as ExecutionExtensions from "@rika/extensions/execution-extension-service"
import { Effect } from "effect"
import type { InteractiveEvent } from "./interactive-event"
import { makeInteractiveQueue } from "./interactive-session-queue"
import { makeInteractiveSubmission } from "./interactive-session-submission"

export const makeInteractiveExecution = (input: any) => {
  const queue = makeInteractiveQueue(input)
  const submit = makeInteractiveSubmission({ ...input, ...queue })
  const safe = <E>(
    dispatch: (event: InteractiveEvent) => void,
    effect: Effect.Effect<
      void,
      E,
      | ThreadRepository.Service
      | TurnRepository.Service
      | ThreadSummaryRepository.Service
      | TranscriptRepository.Service
      | ExecutionBackend.Service
      | ResolvedContext.Service
      | ExecutionExtensions.ExecutionExtensionService
    >,
  ) =>
    effect.pipe(
      Effect.provide(input.executionDependencies),
      Effect.scoped,
      Effect.catch((error) => Effect.sync(() => input.dispatchFailure(dispatch, error))),
    )
  return { submit, safe, ...queue }
}
