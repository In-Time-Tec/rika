import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { describe, expect, it } from "@effect/vitest"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ContextBinding from "@rika/kernel/context-binding"
import { NestedOperationFailed } from "@rika/kernel/nested-operation-envelope"
import * as WorkspaceBinding from "@rika/kernel/workspace-binding"
import { NestedOperation, Session, ToolContext } from "generalist"
import { HostBindings } from "generalist/repl"
import { Context, Crypto, Deferred, Effect, Fiber, FileSystem, Inspectable, Layer, Option, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as HostedKernel from "../../src/host/kernel"
import {
  bindingManifest,
  BindingResponse as BindingResponseSchema,
  type BindingOutcome,
  type CellRequest,
  type CellResponse,
} from "../../src/protocol/messages"
import { provideLayer } from "../support/layer"

const access = {
  version: 1 as const,
  fence: {
    target: "runner" as const,
    assignmentId: "assignment-1",
    assignmentGeneration: 1,
    instanceId: "device-1",
    executorId: "executor-1",
    processIncarnation: "process-1",
  },
  leaseEpoch: 1,
  sessionToken: "session-token",
}

const request = (
  manifest: CellRequest["bindings"],
  operationKey: string,
  toolCallId: string,
  code: string,
): CellRequest => ({
  access,
  operationKey,
  workspaceId: "workspace-1",
  sessionId: "session-1",
  threadId: "thread-1",
  turnId: "turn-1",
  runId: "run-1",
  rootRunId: "run-1",
  toolCallId,
  code,
  attempt: 0,
  replayPolicy: "never",
  admittedAt: null,
  deadlineAt: "2999-01-01T00:00:00.000Z",
  bindings: manifest,
})

const toolContext = (operationKey: string, toolCallId: string) =>
  ToolContext.ToolContext.of({
    signal: new AbortController().signal,
    emit: () => Effect.succeed(true),
    sessionId: "session-1",
    runId: "run-1",
    toolCallId,
    operationKey,
  })

const resultValue = (response: CellResponse) => {
  if (response._tag !== "Success") return ""
  const result = Schema.decodeUnknownOption(Schema.Struct({ value: Schema.Json }))(response.result)
  return Option.isSome(result) ? Inspectable.toStringUnknown(result.value.value) : ""
}

describe("hosted TypeScript kernel", () => {
  it.effect("terminalizes a dropped binding result and never accepts or replays it after the deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-binding-deadline-" })
        const manifest = yield* bindingManifest([{ module: "context", operations: ["current"] }])
        const states = yield* Ref.make(new Map<string, import("../../src/protocol/cells").State>())
        const sent: Array<Parameters<HostedKernel.Options["sendBinding"]>[0]> = []
        const bindingSent = yield* Deferred.make<Parameters<HostedKernel.Options["sendBinding"]>[0]>()
        const kernel = yield* HostedKernel.make({
          workspaceIdentity: "workspace-1",
          workspacePath: root,
          dataRoot: root,
          read: (operationKey) => Effect.map(Ref.get(states), (current) => current.get(operationKey)),
          write: (operationKey, state) => Ref.update(states, (current) => new Map(current).set(operationKey, state)),
          sendBinding: (message) =>
            Effect.sync(() => sent.push(message)).pipe(
              Effect.andThen(Deferred.succeed(bindingSent, message)),
              Effect.asVoid,
            ),
        })
        const cell = {
          ...request(manifest, "operation-binding-deadline", "call-binding-deadline", "await rika.context.current({})"),
          deadlineAt: "1970-01-01T00:00:01.000Z",
        }
        const running = yield* Effect.forkChild(
          kernel.execute(cell, () => Effect.void),
          { startImmediately: true },
        )
        const call = yield* Deferred.await(bindingSent)
        yield* TestClock.adjust("1 second")
        expect(yield* Fiber.join(running)).toEqual({
          _tag: "DomainFailure",
          failure: { kind: "timeout", message: "Cell operation deadline exceeded" },
        })

        const late = () =>
          Effect.result(
            kernel.completeBinding({
              operationKey: call.operationKey,
              attempt: call.attempt,
              callId: call.callId,
              requestDigest: call.requestDigest,
              outcome: { _tag: "Returned", response: { _tag: "Success", output: {} } },
            }),
          )
        expect((yield* late())._tag).toBe("Failure")
        expect((yield* late())._tag).toBe("Failure")
        yield* kernel.replayBindings({ ...access, leaseEpoch: 2 })
        expect(sent).toHaveLength(1)
      }).pipe(
        provideLayer(BunFileSystem.layer),
        Effect.provideServiceEffect(
          Crypto.Crypto,
          Effect.scoped(Layer.build(Layer.merge(BunCrypto.layer, BunFileSystem.layer))).pipe(
            Effect.map((context) => Context.get(context, Crypto.Crypto)),
          ),
        ),
      ),
    ),
  )

  it.effect("retires a binding-blocked kernel before cancellation becomes definitive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-binding-cancel-" })
        const manifest = yield* bindingManifest([{ module: "blocking", operations: ["wait"] }])
        const states = yield* Ref.make(new Map<string, import("../../src/protocol/cells").State>())
        const bindingSent = yield* Deferred.make<Parameters<HostedKernel.Options["sendBinding"]>[0]>()
        const kernel = yield* HostedKernel.make({
          workspaceIdentity: "workspace-1",
          workspacePath: root,
          dataRoot: root,
          read: (operationKey) => Effect.map(Ref.get(states), (current) => current.get(operationKey)),
          write: (operationKey, state) => Ref.update(states, (current) => new Map(current).set(operationKey, state)),
          sendBinding: (message) => Deferred.succeed(bindingSent, message).pipe(Effect.asVoid),
        })
        const blocked = request(
          manifest,
          "operation-binding-cancel",
          "call-binding-cancel",
          "await rika.blocking.wait({})",
        )
        const running = yield* Effect.forkChild(
          kernel.execute(blocked, () => Effect.void),
          {
            startImmediately: true,
          },
        )
        yield* Deferred.await(bindingSent)

        const cancellation = yield* kernel.cancel(blocked.operationKey, blocked.attempt)
        expect(cancellation).toEqual({
          _tag: "DomainFailure",
          failure: { kind: "cancelled", message: "Cell operation cancelled" },
        })
        expect(yield* Fiber.join(running)).toEqual(cancellation)

        const recovered = yield* kernel.execute(
          request(
            manifest,
            "operation-after-binding-cancel",
            "call-after-binding-cancel",
            '"available after binding cancellation"',
          ),
          () => Effect.void,
        )
        expect(resultValue(recovered)).toBe("available after binding cancellation")
      }).pipe(
        provideLayer(BunFileSystem.layer),
        Effect.provideServiceEffect(
          Crypto.Crypto,
          Effect.scoped(Layer.build(Layer.merge(BunCrypto.layer, BunFileSystem.layer))).pipe(
            Effect.map((context) => Context.get(context, Crypto.Crypto)),
          ),
        ),
      ),
    ),
  )

  it.effect("keeps Session state, invokes real rika bindings, and suspends API-owned approval", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-hosted-kernel-" })
        const session = yield* Layer.build(Session.layerMemory)
        const nestedRequests: Array<Omit<NestedOperation.Request, "render">> = []
        const nested = NestedOperation.Operations.of({
          run: (input, effect) => {
            nestedRequests.push(
              input.approval === undefined
                ? { kind: input.kind, payload: input.payload, replayPolicy: input.replayPolicy }
                : {
                    kind: input.kind,
                    payload: input.payload,
                    replayPolicy: input.replayPolicy,
                    approval: input.approval,
                  },
            )
            return input.approval === undefined
              ? effect
              : NestedOperation.Suspended.make({
                  token: "approval-token",
                  operationKey: "operation-write",
                  ordinal: 0,
                  capability: input.approval.capability,
                })
          },
        })
        const base = session.pipe(
          Context.add(
            CodingToolRuntime.Service,
            CodingToolRuntime.Service.of({
              run: () => Effect.succeed({ text: "unused", truncated: false }),
            }),
          ),
          Context.add(NestedOperation.Operations, nested),
        )
        const authority = (operationKey: string, toolCallId: string) =>
          Context.add(base, ToolContext.ToolContext, toolContext(operationKey, toolCallId))
        const modules: ReadonlyArray<
          HostBindings.Module<
            CodingToolRuntime.Service | NestedOperation.Operations | Session.SessionDirectory | ToolContext.ToolContext
          >
        > = [ContextBinding.make({ workspace: root, trustMode: "hosted" }), WorkspaceBinding.module]
        const registry = yield* HostBindings.make(modules).pipe(
          Effect.provideContext(authority("operation-1", "call-1")),
        )
        const manifest = yield* bindingManifest(registry.descriptors)
        const bindingContractDigest = yield* Ref.make<string | undefined>("f".repeat(64))
        const states = yield* Ref.make(new Map<string, import("../../src/protocol/cells").State>())
        const kernel: HostedKernel.Interface = yield* HostedKernel.make({
          workspaceIdentity: "workspace-1",
          workspacePath: root,
          dataRoot: root,
          bindingContractDigest,
          read: (operationKey) => Effect.map(Ref.get(states), (current) => current.get(operationKey)),
          write: (operationKey, state) => Ref.update(states, (current) => new Map(current).set(operationKey, state)),
          sendBinding: (message) =>
            registry.invoke({ ...message.request, input: message.request.input }).pipe(
              Effect.provideContext(authority(message.operationKey, message.request.cellId ?? "")),
              Effect.match({
                onFailure: (failure): BindingOutcome => ({ _tag: "Rejected", failure }),
                onSuccess: (response): BindingOutcome => {
                  if (response._tag === "Failure") {
                    const nestedFailure = Schema.decodeUnknownOption(NestedOperationFailed)(response.failure)
                    if (Option.isSome(nestedFailure) && nestedFailure.value.token !== undefined)
                      return { _tag: "Suspend", token: nestedFailure.value.token }
                  }
                  return { _tag: "Returned", response: Schema.decodeUnknownSync(BindingResponseSchema)(response) }
                },
              }),
              Effect.flatMap((outcome) => kernel.completeBinding({ ...message, outcome })),
              Effect.asVoid,
            ),
        })

        const mismatch = yield* Effect.flip(
          kernel.execute(request(manifest, "operation-mismatch", "call-mismatch", "1"), () => Effect.void),
        )
        expect(mismatch.message).toContain("prepared binding contract")
        yield* Ref.set(bindingContractDigest, manifest.digest)
        const first = yield* kernel.execute(
          request(manifest, "operation-1", "call-1", "let count: number = 1; ({ count, epoch: context.epoch })"),
          () => Effect.void,
        )
        const second = yield* kernel.execute(
          request(
            manifest,
            "operation-2",
            "call-2",
            "count += 1; const live = await rika.context.current({}); ({ count, epoch: live.epoch })",
          ),
          () => Effect.void,
        )
        const suspended = yield* kernel.execute(
          request(
            manifest,
            "operation-write",
            "call-write",
            'await rika.workspace.write({ path: "result.txt", content: "changed" })',
          ),
          () => Effect.void,
        )

        expect(resultValue(first)).toContain("operation-1")
        expect(resultValue(second)).toContain('"count":2')
        expect(resultValue(second)).toContain("operation-2")
        expect(suspended).toEqual({ _tag: "Suspend", token: "approval-token" })
        expect(nestedRequests).toEqual([
          {
            kind: "workspace.write",
            payload: { path: "result.txt", content: "changed" },
            replayPolicy: "never",
            approval: { capability: "workspace.write", request: { path: "result.txt" } },
          },
        ])
      }).pipe(
        provideLayer(BunFileSystem.layer),
        Effect.provideServiceEffect(
          Crypto.Crypto,
          Effect.scoped(Layer.build(Layer.merge(BunCrypto.layer, BunFileSystem.layer))).pipe(
            Effect.map((context) => Context.get(context, Crypto.Crypto)),
          ),
        ),
      ),
    ),
  )

  it.effect("contains no /bin/sh -c hosted cell evaluation path", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const sources = yield* Effect.all(
        [
          "../../src/host/session/foreground.ts",
          "../../src/host/service.ts",
          "../../src/host/kernel.ts",
          "../../../kernel/src/cell-executor.ts",
        ].map((path) => fileSystem.readFileString(new URL(path, import.meta.url).pathname)),
      )
      expect(sources.join("\n")).not.toContain("/bin/sh -c")
    }).pipe(provideLayer(BunFileSystem.layer)),
  )
})
