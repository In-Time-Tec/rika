import * as BunServices from "@effect/platform-bun/BunServices"
import { BoxBootstrapDocument } from "@rika/box-executor/bootstrap"
import { WorkspaceBinding } from "@rika/execution"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import { runBoxExecutor } from "../../src/box/daemon"

const boxId = "bx_23456789"
const expected = { buildId: "box-build", protocolVersion: 1 } as const
const ticket = "a".repeat(43)

const bootstrap = (input: {
  readonly placement?: "Orb" | "Runner"
  readonly workspaceId?: string
  readonly placementWorkspaceId?: string
  readonly buildId?: string
  readonly protocolVersion?: number
  readonly url?: string
  readonly workspacePath?: string
  readonly expiresAtMillis?: number
  readonly ticket?: string
}) => {
  const workspaceId = input.workspaceId ?? "box-workspace"
  const placementWorkspaceId = input.placementWorkspaceId ?? workspaceId
  const placement =
    input.placement === "Runner"
      ? { _tag: "Runner" as const, workspaceId: placementWorkspaceId, checkoutFingerprint: "runner-checkout" }
      : { _tag: "Orb" as const, workspaceId: placementWorkspaceId, lineageId: "box-lineage" }
  return Schema.decodeSync(BoxBootstrapDocument)({
    version: 1,
    boxId,
    binding: Schema.decodeSync(WorkspaceBinding)({
      workspaceId,
      assignmentId: "box-assignment",
      generation: 1,
      placement,
      buildId: input.buildId ?? expected.buildId,
      protocolVersion: input.protocolVersion ?? expected.protocolVersion,
    }),
    workspacePath: input.workspacePath ?? "/box/workspace-that-must-not-be-read",
    enrollment: {
      url: input.url ?? `wss://rika.test/api/v2/boxes/${boxId}/executor`,
      ticket: input.ticket ?? ticket,
      expiresAtMillis: input.expiresAtMillis ?? 60_000,
    },
  })
}

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

it.effect("rejects invalid Box placement, fences, credentials, URL, and path before filesystem or socket access", () =>
  withPlatform(
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000)
      const invalid = [
        { value: bootstrap({ placement: "Runner" }), failure: { reason: "placement" } },
        {
          value: bootstrap({ workspaceId: "workspace-a", placementWorkspaceId: "workspace-b" }),
          failure: { reason: "workspace" },
        },
        { value: bootstrap({ buildId: "other-build" }), failure: { reason: "build" } },
        { value: bootstrap({ protocolVersion: 2 }), failure: { reason: "protocol" } },
        { value: bootstrap({ expiresAtMillis: 1_000 }), failure: { kind: "credentials" } },
        { value: bootstrap({ ticket: "invalid-ticket" }), failure: { kind: "credentials" } },
        {
          value: bootstrap({ url: `wss://rika.test/api/v2/boxes/bx_abcdefgh/executor` }),
          failure: { kind: "url" },
        },
        { value: bootstrap({ workspacePath: "relative/workspace" }), failure: { kind: "workspace" } },
      ]
      let sockets = 0
      for (const candidate of invalid) {
        const result = yield* Effect.result(
          runBoxExecutor({
            bootstrap: candidate.value,
            expected,
            connect: () => {
              sockets += 1
              return yieldNeverSocket()
            },
          }),
        )
        expect(result).toMatchObject({ _tag: "Failure", failure: candidate.failure })
      }
      expect(sockets).toBe(0)
    }),
  ),
)

const yieldNeverSocket = (): WebSocket => {
  throw new Error("invalid bootstrap reached socket construction")
}
