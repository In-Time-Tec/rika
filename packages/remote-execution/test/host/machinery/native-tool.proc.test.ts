import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Ref, Schema } from "effect"
import * as Mcp from "@rika/execution/mcp-tools"
import { NativeToolService, type NativeToolState, nativeToolLayer } from "../../../src/host/machinery/native-tool"
import * as Subprocess from "../../../src/host/machinery/native-tool-subprocess"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const fixture = new URL("../../../../extensions/test/mcp/fixture.ts", import.meta.url).pathname
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

it.live(
  "Executor MCP receipts deduplicate calls across reconstruction; Orb subprocess discovers and calls as workspace user",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-executor-mcp-" })
        yield* fs.makeDirectory(`${root}/.rika`)
        yield* fs.writeFileString(`${root}/state.json`, encodeJson({ mode: "healthy" }))
        yield* fs.writeFileString(
          `${root}/.rika/mcp.json`,
          encodeJson({
            servers: {
              fixture: {
                command: process.execPath,
                args: [fixture],
                specialists: { Task: ["echo"] },
              },
            },
          }),
        )
        const catalog = yield* Mcp.capture(root)
        const receipts = yield* Ref.make(new Map<string, NativeToolState>())
        const build = () =>
          Layer.build(
            nativeToolLayer({
              workspace: root,
              read: (id) => Effect.map(Ref.get(receipts), (state) => state.get(id)),
              write: (id, receipt) => Ref.update(receipts, (state) => new Map(state).set(id, receipt)),
            }),
          ).pipe(Effect.map((context) => Context.get(context, NativeToolService)))
        const request = {
          machineId: "operation",
          requestDigest: "pinned-request",
          request: {
            _tag: "NativeTool" as const,
            request: { _tag: "McpCall" as const, capability: catalog[0]!, input: { value: "receipt" } },
          },
        }
        const runtime = yield* build()
        const first = yield* runtime.execute(request)
        expect(first).toMatchObject({ _tag: "Success", value: { result: { text: '"fixture:receipt"' } } })
        expect(yield* runtime.execute(request)).toEqual(first)
        expect(yield* (yield* build()).execute(request)).toEqual(first)
        expect((yield* runtime.execute({ ...request, requestDigest: "changed" }))._tag).toBe("Fenced")
        yield* Ref.update(receipts, (state) =>
          new Map(state).set("unknown", { _tag: "Running", requestDigest: "pinned-request" }),
        )
        expect((yield* (yield* build()).execute({ ...request, machineId: "unknown" }))._tag).toBe("Unknown")
        expect(
          (yield* fs.readFileString(`${root}/events`)).split("\n").filter((event) => event === "call"),
        ).toHaveLength(1)

        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const user = (yield* spawner.string(ChildProcess.make("id", ["-un"]))).trim()
        const child = yield* Subprocess.make({ workspace: root, workspaceUser: user, environment: {} })
        const discovered = yield* child.execute({ _tag: "McpDiscover" })
        expect(discovered._tag).toBe("Success")
        if (discovered._tag !== "Success") return yield* Effect.die("Expected subprocess discovery")
        const subprocessCatalog = yield* Schema.decodeEffect(Schema.fromJsonString(Mcp.Catalog))(
          discovered.value.result.text,
        )
        expect(subprocessCatalog).toEqual(catalog)
        expect(
          yield* child.execute({ _tag: "McpCall", capability: subprocessCatalog[0]!, input: { value: "orb" } }),
        ).toMatchObject({ _tag: "Success", value: { result: { text: '"fixture:orb"' } } })
      }).pipe(
        // Each test is the platform entry point for its scoped runtime.
        // oxlint-disable-next-line effecttsgo/strict-effect-provide
        Effect.provide(BunServices.layer),
      ),
    ),
  { timeout: 20_000 },
)
