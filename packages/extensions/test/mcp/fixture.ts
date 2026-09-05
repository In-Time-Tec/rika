import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Effect, FileSystem, Schema } from "effect"

// This executable fixture deliberately implements discovery failures/drift at the raw MCP protocol boundary.
// oxlint-disable-next-line typescript/no-deprecated
const server = new Server({ name: "rika-fixture", version: "1" }, { capabilities: { tools: {} } })
const main = Effect.gen(function* () {
  const runPromise = Effect.runPromiseWith(yield* Effect.context())
  const fs = yield* FileSystem.FileSystem
  const secret = yield* Config.string("FIXTURE_SECRET").pipe(Config.withDefault(""))
  const state = fs
    .readFileString("state.json")
    .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ mode: Schema.String })))))
  const record = (event: string) => fs.writeFileString("events", `${event}\n`, { flag: "a" })
  yield* record(`start:${process.pid}`)
  // ast-grep-ignore: effect-prefer-terminal -- executable host emits a test credential to verify stderr suppression.
  process.stderr.write(secret)
  server.setRequestHandler(ListToolsRequestSchema, () =>
    runPromise(
      Effect.gen(function* () {
        yield* record("discover")
        const { mode } = yield* state
        if (mode === "discovery-failure") return yield* Effect.die(new Error(secret))
        return {
          tools:
            mode === "missing"
              ? []
              : [
                  {
                    name: "echo",
                    description: mode === "leak" ? secret : "Echo fixture input",
                    inputSchema: {
                      type: "object" as const,
                      properties: { value: { type: mode === "changed" ? "number" : "string" } },
                      required: ["value"],
                    },
                  },
                ],
        }
      }),
    ),
  )
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    runPromise(
      Effect.gen(function* () {
        yield* record("call")
        const { mode } = yield* state
        // ast-grep-ignore: effect-prefer-terminal -- executable host simulates abrupt loss after accepting a call.
        if (mode === "disconnect") process.exit(1)
        if (mode === "hang") return yield* Effect.never
        if (mode === "error") return { isError: true, content: [{ type: "text", text: secret }] }
        if (mode === "leak-result") return { content: [{ type: "text", text: secret }] }
        const input = yield* Schema.decodeUnknownEffect(Schema.Struct({ value: Schema.String }))(
          request.params.arguments,
        )
        return { content: [{ type: "text", text: `fixture:${input.value}` }] }
      }),
    ),
  )
  yield* Effect.tryPromise(() => server.connect(new StdioServerTransport()))
})

await Effect.runPromise(
  main.pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- executable MCP server entry point.
    Effect.provide(BunServices.layer),
  ),
)
