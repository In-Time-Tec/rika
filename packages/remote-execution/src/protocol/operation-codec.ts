import { Effect, Schema } from "effect"
import type { AccessWire, ApiMessage, MachineOutcome, MachineRequest } from "./messages"

export class OperationError extends Schema.TaggedError<OperationError>()("OperationError", {
  kind: Schema.Literals(["authorization", "execution", "fenced", "transport"]),
  message: Schema.String,
}) {}

export type Command = Extract<ApiMessage, { readonly _tag: "MachineExecute" | "MachineCancel" }>

export interface Event {
  readonly _tag: "MachineResult"
  readonly access: AccessWire
  readonly operationKey: string
  readonly attempt: number
  readonly machineId: string
  readonly requestDigest: string
  readonly outcome: MachineOutcome
}

interface MachineExecutionInput {
  readonly operationKey: string
  readonly attempt: number
  readonly machineId: string
  readonly requestDigest: string
  readonly request: MachineRequest
}

export interface Options {
  readonly access: Effect.Effect<AccessWire, OperationError>
  readonly emit: (event: Event) => Effect.Effect<void, OperationError>
  readonly machine: {
    readonly execute: (input: MachineExecutionInput) => Effect.Effect<MachineOutcome, OperationError>
    readonly cancel: (input: {
      readonly machineId: string
      readonly requestDigest: string
      readonly admitted: boolean
    }) => Effect.Effect<MachineOutcome, OperationError>
  }
}

export interface Interface {
  readonly dispatch: (command: Command) => Effect.Effect<void, OperationError>
  readonly quiesce: Effect.Effect<void, OperationError>
}
