/* oxlint-disable effecttsgo/missing-pipeable-signature -- this reader is a context-bound protocol adapter. */
import { Effect, Schema } from "effect"
import { ToolContext } from "generalist"
import * as GeneralistComponents from "generalist/components"
import { RunStore } from "generalist/runtime"

import {
  AssignmentIdentity,
  ExecutorBuildId,
  ExecutorGeneration,
  ExecutorProtocolVersion,
  WorkspaceBinding,
  WorkspaceIdentity,
  sameBinding,
} from "./binding"
import type { CanonicalResult, NativeOperationIntent } from "./operation"

export const maxAdmittedOperations = 128

const ComponentOperation = Schema.Struct({
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  inputDigest: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  binding: WorkspaceBinding,
})
export type ComponentOperation = typeof ComponentOperation.Type

/**
 * A settlement which is safe to forget from the bounded admission window.
 *
 * Acknowledgements and uncertain outcomes deliberately do not belong here:
 * they still carry a recovery obligation and must remain addressable by their
 * immutable operation identity.
 */
export const ComponentTerminalSettlement = Schema.Union([
  Schema.TaggedStruct("Completed", {
    operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    binding: WorkspaceBinding,
    result: Schema.Json,
  }),
  Schema.TaggedStruct("DomainFailure", {
    operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    binding: WorkspaceBinding,
    failure: Schema.Json,
  }),
])
export type ComponentTerminalSettlement = typeof ComponentTerminalSettlement.Type

export type CanonicalTerminalSettlement = Extract<CanonicalResult, { readonly _tag: "Completed" | "DomainFailure" }>

export const WorkspaceComponentState = Schema.Struct({
  binding: Schema.NullOr(WorkspaceBinding),
  admitted: Schema.Array(ComponentOperation).check(Schema.isMaxLength(maxAdmittedOperations)),
})
export type WorkspaceComponentState = typeof WorkspaceComponentState.Type

export const WorkspaceComponentCommand = Schema.Union([
  Schema.TaggedStruct("Bind", { binding: WorkspaceBinding }),
  Schema.TaggedStruct("Admit", { operation: ComponentOperation }),
  Schema.TaggedStruct("Cleanup", {
    operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    settlement: ComponentTerminalSettlement,
  }),
])
export type WorkspaceComponentCommand = typeof WorkspaceComponentCommand.Type

const bindTransition = (state: WorkspaceComponentState, binding: WorkspaceBinding): WorkspaceComponentState => {
  if (state.binding === null) return { binding, admitted: state.admitted }
  if (sameBinding(state.binding, binding)) return state
  if (binding.generation <= state.binding.generation)
    throw new Error("Workspace generation is not newer than the admitted binding")
  return { binding, admitted: [] }
}

const cleanupTransition = (
  state: WorkspaceComponentState,
  command: Extract<WorkspaceComponentCommand, { readonly _tag: "Cleanup" }>,
): WorkspaceComponentState => {
  if (state.binding === null || !sameBinding(state.binding, command.settlement.binding))
    throw new Error("Native operation settlement binding is not the admitted workspace binding")
  const index = state.admitted.findIndex((entry) => entry.operationId === command.operationId)
  if (index < 0) throw new Error("Native operation settlement has no admitted intent")
  const admitted = state.admitted[index]!
  if (admitted.operationId !== command.settlement.operationId)
    throw new Error("Native operation settlement identity does not match the admitted intent")
  if (!sameBinding(admitted.binding, command.settlement.binding))
    throw new Error("Native operation settlement uses a stale workspace binding")
  return { binding: state.binding, admitted: state.admitted.toSpliced(index, 1) }
}

const admitTransition = (
  state: WorkspaceComponentState,
  operation: ComponentOperation,
): WorkspaceComponentState => {
  if (state.binding === null || !sameBinding(state.binding, operation.binding))
    throw new Error("Native operation binding is not the admitted workspace binding")
  const existing = state.admitted.find((entry) => entry.operationId === operation.operationId)
  if (existing !== undefined) {
    if (
      existing.tool === operation.tool &&
      existing.inputDigest === operation.inputDigest &&
      sameBinding(existing.binding, operation.binding)
    )
      return state
    throw new Error("Native operation identity already has a different intent")
  }
  if (state.admitted.length >= maxAdmittedOperations) throw new Error("Native operation admission bound exceeded")
  return { binding: state.binding, admitted: [...state.admitted, operation] }
}

const workspaceComponentTransition = (
  state: WorkspaceComponentState,
  command: WorkspaceComponentCommand,
): WorkspaceComponentState => {
  if (command._tag === "Bind") return bindTransition(state, command.binding)
  if (command._tag === "Cleanup") return cleanupTransition(state, command)
  return admitTransition(state, command.operation)
}

/** Generalist 0.65 Session-owned binding and admission component. */
export const workspaceComponent = GeneralistComponents.make({
  descriptor: {
    version: "1",
    key: "rika-workspace-binding",
    instance: "v2",
    schemaVersion: "1",
    handler: "rika-execution-v2",
    handlerVersion: "1",
    scope: "session",
    access: "session-owner",
    inheritance: "none",
    branch: "restore",
    redaction: "visible",
    maxStateBytes: 98_304,
    maxCommandBytes: 32_768,
    maxReceiptBytes: 65_536,
  },
  state: WorkspaceComponentState,
  command: WorkspaceComponentCommand,
  initial: { binding: null, admitted: [] },
  transition: workspaceComponentTransition,
})

export type WorkspaceComponentLayer = ReturnType<typeof GeneralistComponents.layer>
export const workspaceComponentLayer: WorkspaceComponentLayer = GeneralistComponents.layer([
  workspaceComponent.registration,
])

export class WorkspaceComponentError extends Schema.TaggedError<WorkspaceComponentError>()(
  "RikaExecutionV2WorkspaceComponentError",
  {
    kind: Schema.Literals(["unavailable", "rejected"]),
    message: Schema.String,
  },
) {}

export interface WorkspaceComponentJournal {
  readonly read: Effect.Effect<WorkspaceComponentState, WorkspaceComponentError>
  readonly bind: (
    binding: WorkspaceBinding,
    commandId: string,
  ) => Effect.Effect<WorkspaceComponentState, WorkspaceComponentError>
  readonly admit: (
    operation: NativeOperationIntent,
    commandId: string,
  ) => Effect.Effect<WorkspaceComponentState, WorkspaceComponentError>
  /** Remove one intent only after its canonical Tool Run result is terminal. */
  readonly cleanup: (
    operation: NativeOperationIntent,
    settlement: CanonicalTerminalSettlement,
    commandId: string,
  ) => Effect.Effect<WorkspaceComponentState, WorkspaceComponentError>
}

const componentFailure = (kind: "unavailable" | "rejected") =>
  WorkspaceComponentError.make({
    kind,
    message: kind === "unavailable" ? "Workspace component is unavailable" : "Workspace component command was rejected",
  })

const operationFromIntent = (operation: NativeOperationIntent): ComponentOperation => ({
  operationId: operation.operationId,
  tool: operation.tool,
  inputDigest: operation.inputDigest,
  binding: operation.binding,
})

/** Bridge to Generalist's existing component journal; it never allocates a SQL or cache store. */
export const workspaceComponentJournal: WorkspaceComponentJournal = {
  read: GeneralistComponents.read(workspaceComponent).pipe(Effect.mapError(() => componentFailure("unavailable"))),
  bind: (binding, commandId) =>
    GeneralistComponents.command(workspaceComponent, { id: commandId, command: { _tag: "Bind", binding } }).pipe(
      Effect.mapError(() => componentFailure("rejected")),
    ),
  admit: (operation, commandId) =>
    GeneralistComponents.command(workspaceComponent, {
      id: commandId,
      command: { _tag: "Admit", operation: operationFromIntent(operation) },
    }).pipe(Effect.mapError(() => componentFailure("rejected"))),
  cleanup: (operation, settlement, commandId) =>
    GeneralistComponents.command(workspaceComponent, {
      id: commandId,
      command:
        settlement._tag === "Completed"
          ? {
              _tag: "Cleanup",
              operationId: operation.operationId,
              settlement: {
                _tag: "Completed",
                operationId: settlement.operationId,
                binding: settlement.binding,
                result: settlement.result,
              },
            }
          : {
              _tag: "Cleanup",
              operationId: operation.operationId,
              settlement: {
                _tag: "DomainFailure",
                operationId: settlement.operationId,
                binding: settlement.binding,
                failure: settlement.failure,
              },
            },
    }).pipe(Effect.mapError(() => componentFailure("rejected"))),
}

const readParentComponent = (toolContext: ToolContext.Service, runStore: RunStore.Service) =>
  Effect.gen(function* () {
    const toolRunId = toolContext.runId
    if (toolRunId === undefined)
      return yield* componentFailure("unavailable")
    const toolExecution = yield* runStore.loadExecution(toolRunId)
    const parentRunId = toolExecution.parentRunId
    if (parentRunId === undefined)
      return yield* componentFailure("unavailable")
    const parentExecution = yield* runStore.loadExecution(parentRunId)
    if (parentExecution.rootRunId !== toolExecution.rootRunId)
      return yield* componentFailure("unavailable")
    const parentEntry = parentExecution.executableManifest.entries.find(
      (entry) => entry.pin === parentExecution.executableRef.active,
    )
    if (parentEntry?._tag !== "Agent") return yield* componentFailure("unavailable")
    const checkpoint = parentExecution.sessionComponents?.find(
      (entry) =>
        entry.descriptor.key === workspaceComponent.registration.descriptor.key &&
        entry.descriptor.instance === workspaceComponent.registration.descriptor.instance,
    )
    if (checkpoint === undefined) return yield* componentFailure("unavailable")
    if (
      checkpoint.pin !== workspaceComponent.registration.pin ||
      !Schema.toEquivalence(GeneralistComponents.Descriptor)(
        checkpoint.descriptor,
        workspaceComponent.registration.descriptor,
      )
    )
      return yield* componentFailure("unavailable")
    return yield* Schema.decodeUnknownEffect(WorkspaceComponentState)(checkpoint.state).pipe(
      Effect.mapError(() => componentFailure("unavailable")),
    )
  }).pipe(Effect.mapError(() => componentFailure("unavailable")))

/** Read the immutable admission from the canonical parent Agent Run without claiming a Session writer. */
export const workspaceComponentReader = (
  toolContext: ToolContext.Service,
  runStore: RunStore.Service,
): WorkspaceComponentJournal => ({
  read: readParentComponent(toolContext, runStore),
  bind: () => Effect.fail(componentFailure("rejected")),
  admit: () => Effect.fail(componentFailure("rejected")),
  cleanup: () => Effect.fail(componentFailure("rejected")),
})

export interface WorkspaceComponentContract {
  readonly AssignmentIdentity: typeof AssignmentIdentity
  readonly ExecutorBuildId: typeof ExecutorBuildId
  readonly ExecutorGeneration: typeof ExecutorGeneration
  readonly ExecutorProtocolVersion: typeof ExecutorProtocolVersion
  readonly WorkspaceBinding: typeof WorkspaceBinding
  readonly WorkspaceIdentity: typeof WorkspaceIdentity
  readonly ComponentTerminalSettlement: typeof ComponentTerminalSettlement
  readonly declaration: typeof workspaceComponent
  readonly layer: WorkspaceComponentLayer
  readonly journal: WorkspaceComponentJournal
  readonly maxAdmittedOperations: typeof maxAdmittedOperations
}

const workspaceComponentContract = {
  AssignmentIdentity,
  ExecutorBuildId,
  ExecutorGeneration,
  ExecutorProtocolVersion,
  WorkspaceBinding,
  WorkspaceIdentity,
  ComponentTerminalSettlement,
  declaration: workspaceComponent,
  layer: workspaceComponentLayer,
  journal: workspaceComponentJournal,
  maxAdmittedOperations,
} satisfies WorkspaceComponentContract

export const WorkspaceComponent: WorkspaceComponentContract = workspaceComponentContract
