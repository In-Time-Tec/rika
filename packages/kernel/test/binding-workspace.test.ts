import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Schema } from "effect"
import { HostBindingRegistry } from "@batonfx/repl"
import { NestedOperation, ToolContext } from "@batonfx/core"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as WorkspaceBinding from "@rika/kernel/workspace-binding"

const toolContext = ToolContext.ToolContext.of({
  signal: new AbortController().signal,
  emit: () => Effect.void,
  sessionId: "session",
  runId: "run",
  toolCallId: "call",
  operationKey: "operation",
})

const registry = (options: {
  readonly run: CodingToolRuntime.Interface["run"]
  readonly nested?: NestedOperation.Interface
}) =>
  Effect.provideContext(
    HostBindingRegistry.make([WorkspaceBinding.module]),
    Context.empty().pipe(
      Context.add(CodingToolRuntime.Service, CodingToolRuntime.Service.of({ run: options.run })),
      Context.add(ToolContext.ToolContext, toolContext),
      Context.add(
        NestedOperation.NestedOperations,
        NestedOperation.NestedOperations.of(options.nested ?? { run: (_request, effect) => effect }),
      ),
    ),
  )

const result = (text: string) => Effect.succeed({ text, truncated: false })

describe("workspace binding", () => {
  it.effect("mounts exactly the model-facing operation names", () =>
    Effect.gen(function* () {
      const mounted = yield* registry({ run: () => result("") })
      expect(mounted.descriptors).toEqual([
        { module: "workspace", operations: ["search", "list", "read", "write", "replace"] },
      ])
    }),
  )

  it.effect("maps search onto the Grep request and returns the bounded reply", () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = []
      const mounted = yield* registry({
        run: (request) => {
          seen.push(request)
          return result("matched")
        },
      })
      const response = yield* mounted.invoke({
        module: "workspace",
        operation: "search",
        input: { pattern: "needle" },
      })
      yield* mounted.invoke({
        module: "workspace",
        operation: "search",
        input: { pattern: "needle", path: "packages/x/**" },
      })
      expect(seen).toEqual([
        { _tag: "Grep", pattern: "needle", regex: false },
        { _tag: "Grep", pattern: "needle", regex: false, path: "packages/x/**" },
      ])
      expect(response).toEqual({ _tag: "Success", output: { text: "matched", truncated: false } })
    }),
  )

  it.effect("maps list options and returns the structured bounded listing", () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = []
      const mounted = yield* registry({
        run: (request) => {
          seen.push(request)
          return Effect.succeed({
            text: "src/\n└── a.ts",
            entries: [{ name: "a.ts", kind: "file" }],
            truncated: false,
          })
        },
      })
      const defaults = yield* mounted.invoke({ module: "workspace", operation: "list", input: {} })
      const scoped = yield* mounted.invoke({
        module: "workspace",
        operation: "list",
        input: { path: "src", depth: 3 },
      })
      expect(seen).toEqual([{ _tag: "List" }, { _tag: "List", path: "src", depth: 3 }])
      expect(defaults).toEqual({
        _tag: "Success",
        output: {
          text: "src/\n└── a.ts",
          entries: [{ name: "a.ts", kind: "file" }],
          truncated: false,
        },
      })
      expect(scoped._tag).toBe("Success")
    }),
  )

  it.effect("maps the read range onto readRange", () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = []
      const mounted = yield* registry({
        run: (request) => {
          seen.push(request)
          return result("lines")
        },
      })
      yield* mounted.invoke({ module: "workspace", operation: "read", input: { path: "src/a.ts", range: [1, 20] } })
      expect(seen).toEqual([{ _tag: "Read", path: "src/a.ts", readRange: [1, 20] }])
    }),
  )

  it.effect("carries the diff of a replace back to the cell", () =>
    Effect.gen(function* () {
      const mounted = yield* registry({
        run: () => Effect.succeed({ text: "edited", truncated: false, diff: "@@ -1 +1 @@" }),
      })
      const response = yield* mounted.invoke({
        module: "workspace",
        operation: "replace",
        input: { path: "src/a.ts", oldStr: "a", newStr: "b" },
      })
      expect(response).toEqual({
        _tag: "Success",
        output: { text: "edited", truncated: false, diff: "@@ -1 +1 @@" },
      })
    }),
  )

  it.effect("returns a runtime failure as tagged data, never a defect", () =>
    Effect.gen(function* () {
      const mounted = yield* registry({
        run: () =>
          CodingToolRuntime.ToolError.make({
            tool: "write",
            message: "denied",
            kind: "operation",
            category: "access_denied",
            outcome: "known",
            recovery: "after_change",
            nextAction: "use an accessible path",
          }),
      })
      const response = yield* mounted.invoke({
        module: "workspace",
        operation: "write",
        input: { path: "/etc/passwd", content: "x" },
      })
      expect(response._tag).toBe("Failure")
      if (response._tag === "Failure") expect((response.failure as { readonly _tag: string })._tag).toBe("ToolError")
    }),
  )

  it.effect("rejects an input that does not match the operation schema", () =>
    Effect.gen(function* () {
      const mounted = yield* registry({ run: () => result("") })
      const failure = yield* Effect.flip(mounted.invoke({ module: "workspace", operation: "read", input: { path: 7 } }))
      expect(Schema.is(HostBindingRegistry.HostBindingSchemaFailure)(failure)).toBe(true)
    }),
  )

  it.effect("fails typed when the cell addresses an operation that is not mounted", () =>
    Effect.gen(function* () {
      const mounted = yield* registry({ run: () => result("") })
      const failure = yield* Effect.flip(mounted.invoke({ module: "workspace", operation: "delete", input: {} }))
      expect(Schema.is(HostBindingRegistry.HostBindingNotFound)(failure)).toBe(true)
    }),
  )

  it.effect("journals writes and replaces as nested operations and leaves reads alone", () =>
    Effect.gen(function* () {
      const kinds: Array<string> = []
      const mounted = yield* registry({
        run: () => result(""),
        nested: {
          run: (request, effect) => {
            kinds.push(request.kind)
            return effect
          },
        },
      })
      yield* mounted.invoke({ module: "workspace", operation: "search", input: { pattern: "x" } })
      yield* mounted.invoke({ module: "workspace", operation: "read", input: { path: "a" } })
      yield* mounted.invoke({ module: "workspace", operation: "write", input: { path: "a", content: "b" } })
      yield* mounted.invoke({
        module: "workspace",
        operation: "replace",
        input: { path: "a", oldStr: "b", newStr: "c" },
      })
      expect(kinds).toEqual(["workspace.write", "workspace.replace"])
    }),
  )

  it.effect("requires approval for every mutating workspace operation", () =>
    Effect.gen(function* () {
      const capabilities: Array<string | undefined> = []
      const mounted = yield* registry({
        run: () => result(""),
        nested: {
          run: (request, effect) => {
            capabilities.push(request.approval?.capability)
            return effect
          },
        },
      })
      yield* mounted.invoke({ module: "workspace", operation: "write", input: { path: "a", content: "b" } })
      yield* mounted.invoke({
        module: "workspace",
        operation: "replace",
        input: { path: "a", oldStr: "b", newStr: "c" },
      })
      expect(capabilities).toEqual(["workspace.write", "workspace.replace"])
    }),
  )

  it.effect("carries the never replay policy on every mutating workspace operation", () =>
    Effect.gen(function* () {
      const policies: Array<string> = []
      const mounted = yield* registry({
        run: () => result(""),
        nested: {
          run: (request, effect) => {
            policies.push(request.replayPolicy)
            return effect
          },
        },
      })
      yield* mounted.invoke({ module: "workspace", operation: "write", input: { path: "a", content: "b" } })
      yield* mounted.invoke({
        module: "workspace",
        operation: "replace",
        input: { path: "a", oldStr: "b", newStr: "c" },
      })
      expect(policies).toEqual(["never", "never"])
    }),
  )

  it.effect("reports a nested-operation suspension as tagged data the cell can read", () =>
    Effect.gen(function* () {
      const mounted = yield* registry({
        run: () => result(""),
        nested: {
          run: (request) =>
            NestedOperation.NestedOperationSuspended.make({
              token: "approval-token",
              operationKey: "operation",
              ordinal: 0,
              capability: request.approval?.capability ?? "unknown",
            }),
        },
      })
      const response = yield* mounted.invoke({
        module: "workspace",
        operation: "write",
        input: { path: "a", content: "b" },
      })
      expect(response._tag).toBe("Failure")
      if (response._tag === "Failure") {
        expect(response.failure).toMatchObject({
          _tag: "NestedOperationFailed",
          reason: "suspended",
          kind: "workspace.write",
        })
      }
    }),
  )

  it.effect("reports a divergent nested identity as tagged data the cell can read", () =>
    Effect.gen(function* () {
      const mounted = yield* registry({
        run: () => result(""),
        nested: {
          run: (request) =>
            NestedOperation.NestedOperationDivergence.make({
              operationKey: "operation",
              ordinal: 0,
              recordedKind: "workspace.replace",
              recordedDigest: "recorded",
              requestedKind: request.kind,
              requestedDigest: "requested",
            }),
        },
      })
      const response = yield* mounted.invoke({
        module: "workspace",
        operation: "write",
        input: { path: "a", content: "b" },
      })
      expect(response._tag).toBe("Failure")
      if (response._tag === "Failure") {
        expect(response.failure).toMatchObject({ _tag: "NestedOperationFailed", reason: "divergence" })
      }
    }),
  )

  it.effect("returns the recorded outcome instead of crossing the boundary twice", () =>
    Effect.gen(function* () {
      let calls = 0
      const mounted = yield* registry({
        run: () => {
          calls = calls + 1
          return result(`call ${calls}`)
        },
        nested: { run: (_request, effect) => Effect.flatMap(effect, () => effect) },
      })
      yield* mounted.invoke({ module: "workspace", operation: "write", input: { path: "a", content: "b" } })
      expect(calls).toBe(2)
    }),
  )
})
