import { Controller } from "@rika/e2b-executor/controller"
import {
  AssignmentLeaseEpoch,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  FencingGeneration,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { WorkspacePreparations } from "@rika/product/workspace-preparation"
import { Clock, Context, Crypto, Effect, Encoding, Layer, Redacted, Schema, Scope } from "effect"
import { HostedEnvironment } from "../hosted/environment/runtime"
import { ExecutorGateway, GatewayError, gatewayLayer, type LifecycleStore } from "./gateway"

export const HostedGateway = {
  build: Effect.fn("Executor.makeHostedGateway")(function* (
    lifecycle: LifecycleStore,
    crypto: Crypto.Crypto,
    scope: Scope.Scope,
  ) {
    const controller = yield* Controller
    const environment = yield* HostedEnvironment
    const preparations = yield* WorkspacePreparations
    const preparationAccess = Effect.fn("Executor.preparationAccess")(function* (
      input: import("@rika/remote-execution/protocol").AccessWire,
    ) {
      const digest = Encoding.encodeHex(
        yield* crypto
          .digest("SHA-256", new TextEncoder().encode(input.sessionToken))
          .pipe(
            Effect.mapError(() =>
              GatewayError.make({ kind: "transport", message: "Could not verify executor access" }),
            ),
          ),
      )
      return {
        assignmentId: ExecutorAssignmentId.make(input.fence.assignmentId),
        assignmentGeneration: FencingGeneration.make(String(input.fence.assignmentGeneration)),
        providerInstanceId: input.fence.instanceId,
        executorInstanceId: ExecutorInstanceId.make(input.fence.executorId),
        processIncarnation: input.fence.processIncarnation,
        leaseEpoch: AssignmentLeaseEpoch.make(String(input.leaseEpoch)),
        presentedSessionCredentialDigest: Redacted.make(digest),
      }
    })
    const preparationFailure = (error: GatewayError | { readonly reason: string; readonly message: string }) =>
      Schema.is(GatewayError)(error)
        ? error
        : GatewayError.make({
            kind: error.reason === "database" ? "transport" : "fenced",
            message: error.message,
          })
    const gatewayContext = yield* Layer.buildWithScope(
      gatewayLayer({
        controller,
        lifecycle,
        phases: {
          activate: (executorAccess, phase, use) =>
            environment
              .usePhase({ assignmentId: executorAccess.fence.assignmentId, phase }, (resolved) =>
                controller
                  .activatePhase(
                    {
                      ...executorAccess,
                      sessionToken: Redacted.make(executorAccess.sessionToken, { label: "executor-session" }),
                    },
                    resolved.egress,
                  )
                  .pipe(
                    Effect.andThen(
                      use({
                        digest: resolved.manifest.digest,
                        values: resolved.values,
                        redactedNames: resolved.manifest.references.map((reference) => reference.name),
                      }),
                    ),
                  ),
              )
              .pipe(
                Effect.mapError((error) =>
                  Schema.is(GatewayError)(error)
                    ? error
                    : GatewayError.make({ kind: "fenced", message: "Executor phase authorization was rejected" }),
                ),
              ),
          publication: (executorAccess, use) =>
            environment
              .usePhase({ assignmentId: executorAccess.fence.assignmentId, phase: "runtime" }, (resolved) =>
                Effect.gen(function* () {
                  const access = {
                    ...executorAccess,
                    sessionToken: Redacted.make(executorAccess.sessionToken, { label: "executor-session" }),
                  }
                  const update = (egress: typeof resolved.egress) =>
                    controller
                      .activatePhase(access, egress)
                      .pipe(
                        Effect.mapError(() =>
                          GatewayError.make({ kind: "fenced", message: "Repository publication egress was rejected" }),
                        ),
                      )
                  yield* update({
                    phase: "runtime",
                    allow: [...new Set([...resolved.egress.allow, "github.com"])].toSorted(),
                  })
                  const outcome = yield* Effect.exit(use())
                  yield* update(resolved.egress)
                  return yield* outcome
                }),
              )
              .pipe(
                Effect.mapError((error) =>
                  Schema.is(GatewayError)(error)
                    ? error
                    : GatewayError.make({ kind: "fenced", message: "Repository publication egress is unavailable" }),
                ),
              ),
          replace: (key) =>
            environment
              .usePhase({ assignmentId: key.assignmentId, phase: "runtime" }, (resolved) =>
                controller
                  .replace(key, { egress: resolved.egress, environmentDigest: resolved.manifest.digest })
                  .pipe(Effect.asVoid),
              )
              .pipe(
                Effect.mapError(() =>
                  GatewayError.make({ kind: "fenced", message: "Executor replacement authorization was rejected" }),
                ),
              ),
        },
        preparation: {
          start: (input) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis
              yield* preparations.start({
                access: yield* preparationAccess(input.access),
                workspaceId: input.workspaceId,
                phase: input.phase,
                attempt: input.attempt,
                now,
                deadlineAt: now + 30 * 60 * 1_000,
              })
            }).pipe(Effect.mapError(preparationFailure)),
          output: (input) =>
            Effect.gen(function* () {
              yield* preparations.appendOutput({
                access: yield* preparationAccess(input.access),
                phase: input.phase,
                attempt: input.attempt,
                stream: input.stream,
                text: input.text,
                redacted: true,
                truncated: input.truncated,
                now: yield* Clock.currentTimeMillis,
              })
            }).pipe(Effect.mapError(preparationFailure)),
          complete: (input) =>
            Effect.gen(function* () {
              yield* preparations.complete({
                access: yield* preparationAccess(input.access),
                workspaceId: input.workspaceId,
                phase: input.phase,
                attempt: input.attempt,
                evidence: { ...input.evidence, workspaceId: WorkspaceId.make(input.evidence.workspaceId) },
                now: yield* Clock.currentTimeMillis,
              })
            }).pipe(Effect.mapError(preparationFailure)),
          fail: (input) =>
            Effect.gen(function* () {
              yield* preparations.fail({
                access: yield* preparationAccess(input.access),
                workspaceId: input.workspaceId,
                phase: input.phase,
                attempt: input.attempt,
                message: input.message,
                retryable: input.retryable,
                now: yield* Clock.currentTimeMillis,
              })
            }).pipe(Effect.mapError(preparationFailure)),
          retry: (input) =>
            Effect.flatMap(preparationAccess(input), (resolved) => preparations.retryAttempt(resolved)).pipe(
              Effect.mapError(preparationFailure),
            ),
          ready: (input) =>
            Effect.flatMap(preparationAccess(input), (resolved) => preparations.requireReady(resolved)).pipe(
              Effect.asVoid,
              Effect.mapError(preparationFailure),
            ),
        },
      }),
      scope,
    )
    return Context.get(gatewayContext, ExecutorGateway)
  }),
}
