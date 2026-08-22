import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { describe, expect, it } from "@effect/vitest"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ContextBinding from "@rika/kernel/context-binding"
import * as WorkspaceBinding from "@rika/kernel/workspace-binding"
import { NestedOperation, Session, ToolContext } from "tenetkit"
import { HostBindingRegistry } from "tenetkit/repl"
import { Context, Crypto, Effect, Layer, Ref } from "effect"
import * as HostedKernel from "../src/hosted-kernel"
import {
  bindingManifest,
  type BindingOutcome,
  type BindingResponse,
  type CellRequest,
  type CellResponse,
} from "../src/protocol"

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
  deadline: null,
  bindings: manifest,
})

const toolContext = (operationKey: string, toolCallId: string) =>
  ToolContext.ToolContext.of({
    signal: new AbortController().signal,
    emit: () => Effect.void,
    sessionId: "session-1",
    runId: "run-1",
    toolCallId,
    operationKey,
  })

const resultValue = (response: CellResponse) => {
  if (response._tag !== "Success" || typeof response.result !== "object" || response.result === null) return ""
  return "value" in response.result ? String(response.result.value) : ""
}

describe("hosted TypeScript kernel", () => {
  it.effect("keeps Session state, invokes real rika bindings, and suspends API-owned approval", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/rika-hosted-kernel-"))),
          (path) => Effect.promise(() => import("node:fs/promises").then((fs) => fs.rm(path, { recursive: true }))),
        )
        const session = yield* Layer.build(Session.layerMemory)
        const nestedRequests: Array<NestedOperation.Request> = []
        const nested = NestedOperation.NestedOperations.of({
          run: (input, effect) => {
            nestedRequests.push(input as unknown as NestedOperation.Request)
            return input.approval === undefined
              ? effect
              : NestedOperation.NestedOperationSuspended.make({
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
          Context.add(NestedOperation.NestedOperations, nested),
        )
        const authority = (operationKey: string, toolCallId: string) =>
          Context.add(base, ToolContext.ToolContext, toolContext(operationKey, toolCallId))
        const modules = [
          ContextBinding.make({ workspace: root, trustMode: "hosted" }),
          WorkspaceBinding.module,
        ] as unknown as ReadonlyArray<HostBindingRegistry.Module<never>>
        const registry = yield* HostBindingRegistry.make(modules).pipe(
          Effect.provideContext(authority("operation-1", "call-1")),
        )
        const manifest = yield* bindingManifest(registry.descriptors)
        const bindingContractDigest = yield* Ref.make<string | undefined>("f".repeat(64))
        const states = yield* Ref.make(new Map<string, import("../src/cells").State>())
        let kernel: HostedKernel.Interface
        kernel = yield* HostedKernel.make({
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
                onSuccess: (response): BindingOutcome =>
                  response._tag === "Failure" &&
                  typeof response.failure === "object" &&
                  response.failure !== null &&
                  "_tag" in response.failure &&
                  response.failure._tag === "NestedOperationFailed" &&
                  "token" in response.failure &&
                  typeof response.failure.token === "string"
                    ? { _tag: "Suspend", token: response.failure.token }
                    : { _tag: "Returned", response: response as BindingResponse },
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
        expect(resultValue(second)).toContain("count: 2")
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
        Effect.provideServiceEffect(
          Crypto.Crypto,
          Effect.scoped(Layer.build(BunCrypto.layer)).pipe(
            Effect.map((context) => Context.get(context, Crypto.Crypto)),
          ),
        ),
      ),
    ),
  )

  it.effect("contains no /bin/sh -c hosted cell evaluation path", () =>
    Effect.gen(function* () {
      const sources = yield* Effect.all(
        ["../src/foreground.ts", "../src/host.ts", "../src/hosted-kernel.ts", "../../kernel/src/cell-executor.ts"].map(
          (path) => Effect.promise(() => Bun.file(new URL(path, import.meta.url)).text()),
        ),
      )
      expect(sources.join("\n")).not.toContain("/bin/sh -c")
    }),
  )
})
