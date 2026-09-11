import * as BunServices from "@effect/platform-bun/BunServices"
import { maxBootstrapDocumentBytes } from "@rika/box-executor/bootstrap"
import { Effect, Fiber, Layer, Stdio, Stream } from "effect"
import { TestClock } from "effect/testing"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import { runBoxExecutorMain } from "../../src/box/main"

const expected = { buildId: "box-build", protocolVersion: 1 } as const

const withInput = <A, E, R>(effect: Effect.Effect<A, E, R>, stdin: Stream.Stream<Uint8Array>) =>
  Effect.scoped(
    Layer.build(
      Layer.merge(BunServices.layer, Stdio.layerTest({ args: Effect.succeed(["box", "--bootstrap-stdin"]), stdin })),
    ).pipe(Effect.flatMap((context) => Effect.provide(effect, context))),
  )

const options = (socketCalls: Array<string>) => ({
  expected,
  connect: (url: string): WebSocket => {
    socketCalls.push(url)
    throw new Error("invalid stdin reached socket construction")
  },
})

it.effect("maps malformed and invalid-Box stdin to a secret-free bounded error", () => {
  const secret = "sensitive-bootstrap-ticket-that-must-not-appear"
  const malformed = `{"enrollment":{"ticket":"${secret}"}`
  const invalidBox = JSON.stringify({
    version: 1,
    boxId: "not-a-box",
    binding: {},
    workspacePath: "/workspace",
    enrollment: { url: "wss://rika.test", ticket: secret, expiresAtMillis: 60_000 },
  })
  return Effect.gen(function* () {
    const socketCalls: Array<string> = []
    for (const text of [malformed, invalidBox]) {
      const result = yield* withInput(
        Effect.result(runBoxExecutorMain(options(socketCalls))),
        Stream.make(new TextEncoder().encode(text)),
      )
      expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "input" } })
      if (result._tag === "Failure") expect(result.failure.message).not.toContain(secret)
    }
    expect(socketCalls).toEqual([])
  })
})

it.effect("rejects oversized stdin immediately and bounds an incomplete stdin read", () =>
  Effect.gen(function* () {
    const socketCalls: Array<string> = []
    const oversized = yield* withInput(
      Effect.result(runBoxExecutorMain(options(socketCalls))),
      Stream.make(new Uint8Array(maxBootstrapDocumentBytes + 1)),
    )
    expect(oversized).toMatchObject({ _tag: "Failure", failure: { kind: "input" } })

    const reading = yield* withInput(Effect.result(runBoxExecutorMain(options(socketCalls))), Stream.never).pipe(
      Effect.forkChild,
    )
    yield* TestClock.adjust("10 seconds")
    expect(yield* Fiber.join(reading)).toMatchObject({ _tag: "Failure", failure: { kind: "timeout" } })
    expect(socketCalls).toEqual([])
  }),
)
