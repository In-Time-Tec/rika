import * as InteractiveSession from "@rika/product/interactive-session"
import * as ProductOperation from "@rika/product/product-operation"
import * as ResidentService from "@rika/product/resident-service"
import { Deferred, Effect, Queue } from "effect"

export type CommandQueueItem = {
  readonly sequence: number
  readonly cancelled: Deferred.Deferred<void>
  readonly effect: Effect.Effect<void, ProductOperation.OperationUnavailable | ResidentService.ResidentServiceError>
}

export type ResidentSession = {
  readonly session: InteractiveSession.InteractiveSession
  readonly ended: Deferred.Deferred<void>
  readonly feedGeneration: string
  readonly commands: Map<number, Deferred.Deferred<void>>
  readonly commandReleases: Map<number, Effect.Effect<void>>
  readonly commandQueue: Queue.Queue<CommandQueueItem>
  readonly acceptCommand: (sequence: number) => boolean
  readonly acknowledge: (throughSequence: number) => Effect.Effect<boolean>
  readonly replay: (afterSequence: number) => Effect.Effect<void>
}

export type ResidentRoute = {
  readonly connectionId: string
  readonly send: (text: string) => Effect.Effect<void, ProductOperation.OperationUnavailable>
  readonly sendFrames: (frames: ReadonlyArray<string>) => Effect.Effect<void, ProductOperation.OperationUnavailable>
  readonly sessions: Map<string, ResidentSession>
}
