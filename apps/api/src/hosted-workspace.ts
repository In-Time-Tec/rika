import { ExecutorAssignments } from "@rika/product/executor-assignments"
import { ThreadId } from "@rika/product/hosted-model"
import type { WorkspaceRequest, WorkspaceResponse } from "@rika/product/workspace-capability"
import { Context, Effect, Layer, Schema } from "effect"
import { Executor } from "./executor"
import { HostedEnvironment } from "./hosted-environment"

export class HostedWorkspaceError extends Schema.TaggedError<HostedWorkspaceError>()("HostedWorkspaceError", {
  kind: Schema.Literals(["unsupported", "unavailable"]),
  message: Schema.String,
}) {}

export interface HostedWorkspaceService {
  readonly execute: (
    threadId: string,
    request: WorkspaceRequest,
  ) => Effect.Effect<WorkspaceResponse, HostedWorkspaceError>
  readonly pause: (threadId: string) => Effect.Effect<void, HostedWorkspaceError>
  readonly resume: (threadId: string) => Effect.Effect<void, HostedWorkspaceError>
  readonly portal: (threadId: string, port: number) => Effect.Effect<string, HostedWorkspaceError>
}

export class HostedWorkspace extends Context.Service<HostedWorkspace, HostedWorkspaceService>()(
  "@rika/api/hosted-workspace/HostedWorkspace",
) {}

export const layer = Layer.effect(
  HostedWorkspace,
  Effect.gen(function* () {
    const executor = yield* Executor
    const assignments = yield* ExecutorAssignments
    const environment = yield* HostedEnvironment
    const requireOrb = Effect.fn("HostedWorkspace.requireOrb")(function* (threadId: string) {
      const assignment = yield* assignments
        .getForThread(ThreadId.make(threadId))
        .pipe(
          Effect.mapError(() =>
            HostedWorkspaceError.make({ kind: "unavailable", message: "Workspace assignment is unavailable" }),
          ),
        )
      if (assignment === undefined || assignment.placement._tag !== "OrbPlacement")
        return yield* HostedWorkspaceError.make({
          kind: "unsupported",
          message: "Workspace lifecycle requires an Orb",
        })
      return assignment
    })
    const execute = Effect.fn("HostedWorkspace.execute")(function* (threadId: string, request: WorkspaceRequest) {
      const assignment = yield* assignments
        .getForThread(ThreadId.make(threadId))
        .pipe(
          Effect.mapError(() =>
            HostedWorkspaceError.make({ kind: "unavailable", message: "Workspace assignment is unavailable" }),
          ),
        )
      if (assignment === undefined || assignment.placement._tag !== "OrbPlacement")
        return yield* HostedWorkspaceError.make({
          kind: "unsupported",
          message: "Hosted Workspace access requires an E2B executor",
        })
      const phase =
        assignment.lifecycle._tag === "Paused" || assignment.lifecycle._tag === "Active" ? "runtime" : "setup"
      yield* environment
        .usePhase({ assignmentId: assignment.id, phase }, (resolved) =>
          executor.controller.provision(assignment.id, {
            egress: resolved.egress,
            environmentDigest: resolved.manifest.digest,
          }),
        )
        .pipe(
          Effect.mapError(() =>
            HostedWorkspaceError.make({ kind: "unavailable", message: "Workspace executor is unavailable" }),
          ),
        )
      return yield* executor.gateway
        .workspace(assignment.id, request)
        .pipe(
          Effect.mapError(() =>
            HostedWorkspaceError.make({ kind: "unavailable", message: "Workspace executor is unavailable" }),
          ),
        )
    })
    const pause = Effect.fn("HostedWorkspace.pause")(function* (threadId: string) {
      const assignment = yield* requireOrb(threadId)
      yield* executor
        .pause({ assignmentId: assignment.id, generation: Number(assignment.generation) })
        .pipe(
          Effect.mapError(() => HostedWorkspaceError.make({ kind: "unavailable", message: "Orb could not be paused" })),
        )
    })
    const resume = Effect.fn("HostedWorkspace.resume")(function* (threadId: string) {
      const assignment = yield* requireOrb(threadId)
      yield* executor
        .resume({ assignmentId: assignment.id, generation: Number(assignment.generation) })
        .pipe(
          Effect.mapError(() =>
            HostedWorkspaceError.make({ kind: "unavailable", message: "Orb could not be resumed" }),
          ),
        )
    })
    const portal = Effect.fn("HostedWorkspace.portal")(function* (threadId: string, port: number) {
      const assignment = yield* requireOrb(threadId)
      const key = { assignmentId: assignment.id, generation: Number(assignment.generation) }
      if (assignment.lifecycle._tag === "Paused")
        yield* executor
          .resume(key)
          .pipe(
            Effect.mapError(() =>
              HostedWorkspaceError.make({ kind: "unavailable", message: "Orb could not be resumed" }),
            ),
          )
      return yield* executor.controller
        .portal(key, port)
        .pipe(
          Effect.mapError(() =>
            HostedWorkspaceError.make({ kind: "unavailable", message: "Orb portal is unavailable" }),
          ),
        )
    })
    return HostedWorkspace.of({ execute, pause, resume, portal })
  }),
)
