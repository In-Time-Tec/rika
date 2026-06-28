import { describe, expect, test } from "bun:test"
import { Client } from "@rika/sdk"
import { Codec, Ide as IdeSchema, Ids } from "@rika/schema"
import { Effect, Layer, Schema, Stream } from "effect"
import { Ide, Output } from "../src/index"

const clientId = Ids.IdeClientId.make("ide_cli_client")
const context: IdeSchema.ContextSnapshot = {
  workspace_roots: ["/workspace/rika"],
  active_file: {
    path: "packages/cli/src/runtime.ts",
    selection: { range: { start_line: 10, end_line: 12 }, selected_text: "const mode = 'smart'" },
  },
}

const makeLayer = (output: Output.MemoryOutput, calls: Array<Client.RequestInput>) => {
  const client = Client.make({
    requestJson: (input) => {
      calls.push(input)
      switch (input.path) {
        case "/v1/ide/status":
          return Effect.succeed(
            Codec.encode(IdeSchema.Status)({
              connected: false,
              capabilities: [],
              workspace_roots: [],
            }),
          )
        case "/v1/ide/connect":
          return Effect.succeed(
            Codec.encode(IdeSchema.ConnectResponse)({
              client_id: clientId,
              connected: true,
              capabilities: ["active-context", "diagnostics", "navigation"],
            }),
          )
        case "/v1/ide/disconnect":
          return Effect.succeed(
            Codec.encode(IdeSchema.Status)({ connected: false, capabilities: [], workspace_roots: [] }),
          )
        case "/v1/ide/open-file":
          return Effect.succeed(Codec.encode(IdeSchema.OpenFileResult)({ accepted: true }))
        case "/v1/ide/navigation-requests":
          return Effect.succeed(Codec.encode(Schema.Array(IdeSchema.OpenFileRequest))([]))
      }
      return Effect.die(`unexpected request ${input.path}`)
    },
    streamJson: () => Stream.empty,
  })
  return Ide.layerFromClient(client).pipe(Layer.provideMerge(Output.memoryLayer(output)))
}

describe("CLI IDE commands", () => {
  test("connects, inspects, disconnects, and requests file navigation over the SDK", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<Client.RequestInput> = []
    const layer = makeLayer(output, calls)

    const statusCode = await Effect.runPromise(
      Ide.executeCommand({ type: "ide", action: "status" }).pipe(Effect.provide(layer)),
    )
    const connectCode = await Effect.runPromise(
      Ide.executeCommand({
        type: "ide",
        action: "connect",
        client_id: clientId,
        workspace_roots: ["/workspace/rika"],
        capabilities: ["active-context", "diagnostics", "navigation"],
        initial_context: context,
      }).pipe(Effect.provide(layer)),
    )
    const openCode = await Effect.runPromise(
      Ide.executeCommand({
        type: "ide",
        action: "open-file",
        open_file: { path: "packages/cli/src/runtime.ts", range: { start_line: 10, end_line: 12 } },
      }).pipe(Effect.provide(layer)),
    )
    const disconnectCode = await Effect.runPromise(
      Ide.executeCommand({ type: "ide", action: "disconnect", client_id: clientId }).pipe(Effect.provide(layer)),
    )

    expect([statusCode, connectCode, openCode, disconnectCode]).toEqual([0, 0, 0, 0])
    expect(output.stderr).toEqual([])
    expect(output.stdout.map((line) => JSON.parse(line))).toEqual([
      { connected: false, capabilities: [], workspace_roots: [] },
      { client_id: clientId, connected: true, capabilities: ["active-context", "diagnostics", "navigation"] },
      { accepted: true },
      { connected: false, capabilities: [], workspace_roots: [] },
    ])
    expect(calls).toEqual([
      { method: "GET", path: "/v1/ide/status" },
      {
        method: "POST",
        path: "/v1/ide/connect",
        body: {
          client_id: clientId,
          workspace_roots: ["/workspace/rika"],
          capabilities: ["active-context", "diagnostics", "navigation"],
          initial_context: context,
        },
      },
      {
        method: "POST",
        path: "/v1/ide/open-file",
        body: { path: "packages/cli/src/runtime.ts", range: { start_line: 10, end_line: 12 } },
      },
      { method: "POST", path: "/v1/ide/disconnect", body: { client_id: clientId } },
    ])
  })
})
