import { describe, expect, test } from "bun:test"
import { Config, Diagnostics, SecretRedactor } from "@rika/core"
import { HttpServer } from "@rika/server"
import { Effect, Fiber, Layer, ManagedRuntime, Ref } from "effect"
import { Output, Server } from "../src/index"

describe("CLI server command", () => {
  test("prints the server URL and closes the handle when interrupted", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    const closeRef = Effect.runSync(Ref.make(false))
    const served: Array<HttpServer.ServeInput | undefined> = []
    const httpLayer = Layer.succeed(
      HttpServer.Service,
      HttpServer.Service.of({
        handle: () => Effect.succeed(new Response()),
        serve: (input) =>
          Effect.sync(() => {
            served.push(input)
            return {
              url: "http://127.0.0.1:4587",
              close: () => Ref.set(closeRef, true),
            }
          }),
      }),
    )
    const configLayer = Config.layerFromValues({
      workspace_root: "/workspace/rika-cli-test",
      data_dir: "/workspace/rika-cli-test/.rika",
      default_mode: "smart",
    })
    const redactorLayer = SecretRedactor.layer
    const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
    const layer = Server.layer.pipe(
      Layer.provideMerge(Output.memoryLayer(output)),
      Layer.provideMerge(httpLayer),
      Layer.provideMerge(configLayer),
      Layer.provideMerge(diagnosticsLayer),
    )
    const runtime = ManagedRuntime.make(layer)

    const fiber = runtime.runFork(
      Server.executeCommand({
        type: "server",
        host: "0.0.0.0",
        port: 4587,
        token: "secret",
        workspace_root: "/home/user/repo",
        orb: true,
        base_commit: "abc123",
        ephemeral: true,
      }),
    )
    while (output.stdout.length === 0) await Bun.sleep(1)
    await runtime.runPromise(Fiber.interrupt(fiber))
    const closed = Effect.runSync(Ref.get(closeRef))

    expect(output.stdout).toEqual([JSON.stringify({ url: "http://127.0.0.1:4587" })])
    expect(output.stderr).toEqual([])
    expect(served).toEqual([
      {
        host: "0.0.0.0",
        port: 4587,
        token: "secret",
        workspace_root: "/home/user/repo",
        orb: true,
        base_commit: "abc123",
      },
    ])
    expect(closed).toBe(true)
  })
})
