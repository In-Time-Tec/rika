import { describe, expect, test } from "bun:test"
import { Ids, Ide } from "@rika/schema"
import { Effect, Option } from "effect"
import { IdeBridge } from "../src/index"

const clientId = Ids.IdeClientId.make("ide_test_client")

const context: Ide.ContextSnapshot = {
  workspace_roots: ["/workspace/rika"],
  active_file: {
    path: "packages/cli/src/runtime.ts",
    language_id: "typescript",
    selection: { range: { start_line: 10, end_line: 12 }, selected_text: "const mode = 'smart'" },
  },
  diagnostics: [
    {
      path: "packages/cli/src/runtime.ts",
      severity: "warning",
      message: "Unused symbol",
      range: { start_line: 11, end_line: 11 },
      source: "tsserver",
    },
  ],
}

describe("IdeBridge", () => {
  test("tracks optional IDE context and turns it into untrusted context entries", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const connected = yield* IdeBridge.connect({
          client_id: clientId,
          name: "Mock IDE",
          workspace_roots: ["/workspace/rika"],
          capabilities: ["active-context", "diagnostics", "navigation"],
          initial_context: context,
        })
        const snapshot = yield* IdeBridge.currentContext()
        const status = yield* IdeBridge.status()
        return { connected, snapshot, status }
      }).pipe(Effect.provide(IdeBridge.layer)),
    )

    expect(result.connected).toEqual({
      client_id: clientId,
      connected: true,
      capabilities: ["active-context", "diagnostics", "navigation"],
    })
    expect(result.status).toMatchObject({ connected: true, client_id: clientId, name: "Mock IDE" })
    expect(Option.getOrUndefined(result.snapshot)).toEqual(context)
    expect(IdeBridge.contextEntries(context)).toMatchObject([
      {
        kind: "file",
        source: "ide:active-file",
        trusted: false,
        path: "packages/cli/src/runtime.ts",
      },
      { kind: "file", source: "ide:diagnostics", trusted: false },
    ])
  })

  test("records navigation requests only when the client has the navigation capability", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const beforeConnect = yield* IdeBridge.openFile({ path: "README.md" })
        yield* IdeBridge.connect({
          client_id: clientId,
          workspace_roots: ["/workspace/rika"],
          capabilities: ["active-context"],
        })
        const withoutCapability = yield* IdeBridge.openFile({ path: "README.md" })
        yield* IdeBridge.connect({
          client_id: clientId,
          workspace_roots: ["/workspace/rika"],
          capabilities: ["navigation"],
        })
        const withCapability = yield* IdeBridge.openFile({ path: "README.md", range: { start_line: 1, end_line: 2 } })
        const requests = yield* IdeBridge.navigationRequests()
        return { beforeConnect, withoutCapability, withCapability, requests }
      }).pipe(Effect.provide(IdeBridge.layer)),
    )

    expect(result.beforeConnect).toEqual({ accepted: false, message: "No IDE client is connected" })
    expect(result.withoutCapability).toEqual({
      accepted: false,
      message: `IDE client ${clientId} does not support navigation`,
    })
    expect(result.withCapability).toEqual({ accepted: true })
    expect(result.requests).toEqual([{ path: "README.md", range: { start_line: 1, end_line: 2 } }])
  })

  test("rejects stale client mutations without changing the active IDE connection", async () => {
    const staleClientId = Ids.IdeClientId.make("ide_stale_client")
    const activeContext: Ide.ContextSnapshot = {
      workspace_roots: ["/workspace/rika"],
      active_file: { path: "packages/ide/src/ide-bridge.ts" },
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* IdeBridge.connect({
          client_id: staleClientId,
          workspace_roots: ["/workspace/rika"],
          capabilities: ["active-context"],
        })
        yield* IdeBridge.connect({
          client_id: clientId,
          workspace_roots: ["/workspace/rika"],
          capabilities: ["active-context"],
          initial_context: activeContext,
        })
        const updateError = yield* IdeBridge.updateContext({
          client_id: staleClientId,
          context: { workspace_roots: ["/stale"], active_file: { path: "stale.ts" } },
        }).pipe(Effect.flip)
        const disconnectError = yield* IdeBridge.disconnect({ client_id: staleClientId }).pipe(Effect.flip)
        const status = yield* IdeBridge.status()
        return { updateError, disconnectError, status }
      }).pipe(Effect.provide(IdeBridge.layer)),
    )

    expect(result.updateError).toMatchObject({ operation: "updateContext", status: 409 })
    expect(result.disconnectError).toMatchObject({ operation: "disconnect", status: 409 })
    expect(result.status).toMatchObject({ connected: true, client_id: clientId, context: activeContext })
  })

  test("empty layer keeps CLI-only sessions disconnected", async () => {
    const status = await Effect.runPromise(IdeBridge.status().pipe(Effect.provide(IdeBridge.emptyLayer)))

    expect(status).toEqual({ connected: false, capabilities: [], workspace_roots: [] })
  })
})
