import * as ExecutionRequest from "@rika/product/execution-request"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { Context, Effect, Layer } from "effect"
import { Service } from "@rika/product/product-operation-service"

export type Session = InteractiveSession
export type Event = InteractiveEvent
export type StartInput = ExecutionRequest.StartInput
export type RunningStatus = ExecutionStatus.Status
export const operationService = Effect.service(Service)

export const memoryTranscripts = Effect.gen(function* () {
  const context = yield* Layer.build(TranscriptRepository.memoryLayer)
  return Context.get(context, TranscriptRepository.Service)
})
