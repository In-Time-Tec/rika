import { describe, expect, test } from "bun:test"
import { HttpServer } from "@rika/server"
import { Effect, Fiber, Layer, ManagedRuntime, Ref } from "effect"
import { Output, Server } from "../src/index"

describe("CLI server command", () => {
  test("prints the server URL and closes the handle when interrupted", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    const closeRef = Effect.runSync(Ref.make(false))
    const httpLayer = Layer.succeed(
      HttpServer.Service,
      HttpServer.Service.of({
        handle: () => Effect.succeed(new Response()),
        serve: () =>
          Effect.succeed({
            url: "http://127.0.0.1:4587",
            close: () => Ref.set(closeRef, true),
          }),
      }),
    )
    const layer = Server.layer.pipe(Layer.provideMerge(Output.memoryLayer(output)), Layer.provideMerge(httpLayer))
    const runtime = ManagedRuntime.make(layer)

    const fiber = runtime.runFork(Server.executeCommand({ type: "server", ephemeral: true }))
    while (output.stdout.length === 0) await Bun.sleep(1)
    await runtime.runPromise(Fiber.interrupt(fiber))
    const closed = Effect.runSync(Ref.get(closeRef))

    expect(output.stdout).toEqual([JSON.stringify({ url: "http://127.0.0.1:4587" })])
    expect(output.stderr).toEqual([])
    expect(closed).toBe(true)
  })
})
