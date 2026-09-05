import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Schema, Stream } from "effect"
import { Pins } from "generalist"
import { TestModel } from "generalist/test"
import * as Gateway from "@rika/product/execution-gateway"
import { layerMemory, remoteTools, type MemoryOptions } from "../../src/engine/runtime"
import * as RemoteTools from "../../src/remote-tools"
import * as LocalTools from "../../src/tool/local"
import * as Mcp from "../../src/tool/mcp"
import * as ToolRuntime from "@rika/product/native-tool-runtime"
import { laneExecutionRoute, makeLaneModels, step } from "../../src/test-harness"

const fixture = new URL("../../../extensions/test/mcp/fixture.ts", import.meta.url).pathname
const toolName = `mcp_${Pins.digest(["fixture", "echo"]).slice(0, 32)}`
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

for (const placement of ["local", "remote"] as const) {
  for (const mode of ["healthy", "changed", "revoked", "disconnect"] as const) {
    it.live(
      `a durable Librarian child uses the pinned MCP catalog after reconstruction: ${placement}/${mode}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-child-mcp-" })
            yield* fs.makeDirectory(`${root}/.rika`)
            yield* fs.writeFileString(`${root}/state.json`, encodeJson({ mode: "healthy" }))
            const config = {
              servers: {
                fixture: {
                  command: process.execPath,
                  args: [fixture],
                  cwd: root,
                  specialists: { Librarian: ["echo"] },
                },
              },
            }
            yield* fs.writeFileString(`${root}/.rika/mcp.json`, encodeJson(config))
            const models = yield* makeLaneModels([
              {
                profile: "Root",
                steps: [
                  step.turn([step.spawn([{ profile: "Librarian", prompt: "Call the fixture" }], "child")]),
                  step.text("parent done"),
                ],
              },
              {
                profile: "Librarian",
                steps: [
                  step.turn([TestModel.toolCall(toolName, { value: "child-proof" }, { id: "mcp-call" })]),
                  step.text("child done"),
                ],
              },
            ])
            const executorContext = yield* Layer.build(LocalTools.layer(root))
            const runtime = Context.get(executorContext, ToolRuntime.Service)
            const requests: Array<RemoteTools.Request> = []
            const options: MemoryOptions = {
              modelServices: models.registryLayer,
            }
            if (placement === "remote")
              Object.assign(options, {
                tools: remoteTools({
                  admit: () =>
                    Mcp.capture(root).pipe(
                      Effect.mapError(() => RemoteTools.AdmissionFailure.make({ message: "MCP unavailable" })),
                    ),
                  tools: RemoteTools.layer({
                    execute: (request) => {
                      requests.push(request)
                      return runtime.run(request.request).pipe(
                        Effect.match({
                          onFailure: (failure) => ({
                            _tag: "DomainFailure" as const,
                            failure: Schema.encodeSync(ToolRuntime.ToolError)(failure),
                          }),
                          onSuccess: (result) => ({ _tag: "Success" as const, result }),
                        }),
                      )
                    },
                    cancel: () => Effect.succeed({ _tag: "Cancelled" as const }),
                  }),
                }),
              })
            const prepared = yield* Effect.scoped(
              Effect.gen(function* () {
                const context = yield* Layer.build(layerMemory(options))
                return yield* Context.get(context, Gateway.Service).prepareTurn({
                  threadId: "mcp-thread",
                  turnId: "mcp-turn",
                  workspaceId: placement === "local" ? root : "opaque-workspace",
                  prompt: "Delegate",
                  executionRoute: laneExecutionRoute(),
                })
              }),
            )
            const discoveryEvents = yield* fs.readFileString(`${root}/events`)
            expect(discoveryEvents.split("\n").filter((line) => line === "discover")).toHaveLength(1)
            if (mode === "revoked")
              yield* fs.writeFileString(`${root}/.rika/mcp.json`, encodeJson({ ...config, disabled: ["fixture"] }))
            else yield* fs.writeFileString(`${root}/state.json`, encodeJson({ mode }))
            // A fresh runtime only has the serialized admission. It must not discover a new toolkit.
            const context = yield* Layer.build(layerMemory(options))
            const gateway = Context.get(context, Gateway.Service)
            const link = yield* gateway.admitTurn(prepared)
            yield* gateway.activateTurn(prepared, link)
            yield* gateway.watchTurn(link, { prompt: "Delegate" }).pipe(Stream.runCollect)
            const prompts = encodeJson(yield* models.promptsFor("Librarian"))
            expect(prompts).toContain(
              {
                healthy: "fixture:child-proof",
                changed: "MCP capability changed",
                revoked: "MCP capability denied",
                disconnect: "MCP capability unknown",
              }[mode],
            )
            expect(yield* models.requestCountFor("Root")).toBe(2)
            expect(yield* models.requestCountFor("Librarian")).toBe(2)
            if (placement === "remote") {
              expect(requests).toHaveLength(1)
              expect(requests[0]?.workspaceId).toBe("opaque-workspace")
              expect(requests[0]?.runId).not.toBe(requests[0]?.rootRunId)
              expect(requests[0]?.request._tag).toBe("McpCall")
              expect(requests[0]?.operationKey).toBeTruthy()
            }
            const events = yield* fs.readFileString(`${root}/events`)
            expect(events.split("\n").filter((line) => line === "call")).toHaveLength(
              mode === "healthy" || mode === "disconnect" ? 1 : 0,
            )
            expect(events.split("\n").filter((line) => line === "discover")).toHaveLength(mode === "revoked" ? 1 : 2)
            // Reobserving the durable result must not call the server a second time.
            yield* gateway.watchTurn(link, { prompt: "Delegate" }).pipe(Stream.runCollect)
            expect(yield* fs.readFileString(`${root}/events`)).toBe(events)
          }).pipe(
            // Each test is the platform entry point for its scoped runtime.
            // oxlint-disable-next-line effecttsgo/strict-effect-provide
            Effect.provide(BunServices.layer),
          ),
        ),
      { timeout: 20_000 },
    )
  }
}
