import "./tool-policy.harness"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { describe, expect, it } from "@effect/vitest"
import { BindingRequest } from "@rika/remote-execution/protocol"
import { NestedOperation, ToolContext } from "tenetkit"
import { Context, Crypto, Effect, Layer, Schema } from "effect"
import { argumentsDigest, invokeAdmittedTool, policyFor, type ToolAdmissionContext } from "../../../src/hosted/execution/tool-policy"
import { testToolPolicy } from "./tool-policy.fixture"

const request = (module: string, operation: string, input: Exclude<BindingRequest["input"], undefined>) =>
  Schema.decodeSync(BindingRequest)({
    module,
    operation,
    input,
    sessionId: "thread-test",
    cellId: "cell-test",
  })

const access = {
  version: 1 as const,
  fence: {
    target: "orb" as const,
    assignmentId: "assignment-test",
    assignmentGeneration: 1,
    instanceId: "sandbox-test",
    executorId: "executor-test",
    processIncarnation: "process-test",
  },
  leaseEpoch: 1,
  sessionToken: "session-test",
}

describe("hosted tool policy", () => {
  it("classifies every high-impact terminal action for exact approval", () => {
    expect(policyFor(request("workspace", "read", { path: "README.md" }))).toMatchObject({
      sideEffect: "none",
      approval: "none",
    })
    expect(policyFor(request("harness", "createPromptNote", { value: "private prompt" }))).toMatchObject({
      sideEffect: "hosted-state",
      approval: "none",
      replayPolicy: "never",
    })
    for (const [command, capability, sideEffect] of [
      ["bun run check", "terminal.execute", "terminal"],
      ["git commit -m safe", "git.execute", "git"],
      ["printenv API_TOKEN", "secret.access", "secret"],
      ["npm publish", "publishing.execute", "publishing"],
      ["git push origin main", "publishing.execute", "publishing"],
    ] as const)
      expect(policyFor(request("processes", "start", { command }))).toMatchObject({
        capability,
        sideEffect,
        approval: "exact",
        replayPolicy: "never",
      })
    expect(() => policyFor(request("workspace", "missing", {}))).toThrow("not admitted")
  })

  it.effect("digests exact arguments without retaining their contents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(BunCrypto.layer)
        const crypto = Context.get(services, Crypto.Crypto)
        const secret = "raw-secret-marker"
        const left = yield* argumentsDigest({ token: secret, command: "git push" }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
        )
        const reordered = yield* argumentsDigest({ command: "git push", token: secret }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
        )
        const changed = yield* argumentsDigest({ token: secret, command: "git status" }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
        )
        expect(left).toMatch(/^[a-f0-9]{64}$/)
        expect(left).toBe(reordered)
        expect(left).not.toBe(changed)
        expect(left).not.toContain(secret)
      }),
    ),
  )

  it.effect("requires the exact durable approval even when an audit record claims approval", () => {
    let invoked = false
    let admission: ToolAdmissionContext | undefined
    let nestedRequest: Pick<NestedOperation.Request, "kind" | "approval"> | undefined
    const policy = {
      ...testToolPolicy,
      begin: (input: Parameters<typeof testToolPolicy.begin>[0]) =>
        testToolPolicy.begin(input).pipe(Effect.tap((value) => Effect.sync(() => void (admission = value)))),
    }
    const layer = Layer.mergeAll(
      BunCrypto.layer,
      Layer.succeed(
        ToolContext.ToolContext,
        ToolContext.ToolContext.of({
          signal: new AbortController().signal,
          emit: () => Effect.void,
          sessionId: "thread-test",
          runId: "run-test",
          toolCallId: "call-test",
          operationKey: "operation-test",
        }),
      ),
      Layer.succeed(
        NestedOperation.NestedOperations,
        NestedOperation.NestedOperations.of({
          run: (candidate) => {
            nestedRequest = candidate
            return NestedOperation.NestedOperationSuspended.make({
              token: "approval-token",
              operationKey: "operation-test",
              ordinal: 0,
              capability: candidate.approval?.capability ?? "unknown",
            })
          },
        }),
      ),
    )
    return Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(layer)
        const outcome = yield* invokeAdmittedTool({
          policyService: policy,
          threadId: "thread-test",
          turnId: "turn-test",
          workspaceId: "workspace-test",
          operationKey: "operation-test",
          callId: "call-test",
          request: request("processes", "start", {
            command: "git push https://raw-secret-marker@example.test/repository",
          }),
          access,
          invoke: Effect.sync(() => {
            invoked = true
            return { _tag: "Success", output: null }
          }),
        }).pipe(Effect.provide(services))
        expect(outcome).toEqual({ _tag: "Suspend", token: "approval-token" })
        expect(invoked).toBe(false)
        expect(admission?.argumentsDigest).toMatch(/^[a-f0-9]{64}$/)
        expect(nestedRequest).toMatchObject({
          kind: "rika.tool.processes.start",
          approval: {
            capability: "publishing.execute",
            request: {
              operation: { module: "processes", name: "start" },
              workspace: "workspace-test",
              executor: { assignmentId: "assignment-test" },
            },
          },
        })
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(nestedRequest)
        expect(encoded).not.toContain("raw-secret-marker")
      }),
    )
  })
})
