import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Driver, Manager, PtyError, Repository, layer as ptyLayer, type Record } from "../src/pty"
import { provideLayer } from "./support/layer"

const harness = () => {
  const records = new Map<string, Record>()
  const calls: Array<string> = []
  const repository = Layer.succeed(
    Repository,
    Repository.of({
      get: (ptyId) => Effect.succeed(records.get(ptyId)),
      insert: (record) => {
        if (records.has(record.ptyId)) return Effect.fail(PtyError.make({ kind: "conflict", message: "exists" }))
        records.set(record.ptyId, record)
        return Effect.succeed(record)
      },
      update: (record, revision) => {
        const current = records.get(record.ptyId)
        if (current === undefined) return Effect.fail(PtyError.make({ kind: "missing", message: "missing" }))
        if (current.revision !== revision) return Effect.fail(PtyError.make({ kind: "conflict", message: "stale" }))
        const next = { ...record, revision: revision + 1 }
        records.set(record.ptyId, next)
        return Effect.succeed(next)
      },
    }),
  )
  const driver = Layer.succeed(
    Driver,
    Driver.of({
      create: (request) => Effect.sync(() => calls.push(`create:${request.ptyId}`)),
      input: (request) => Effect.sync(() => calls.push(`input:${request.data}`)),
      resize: (request) => Effect.sync(() => calls.push(`resize:${request.cols}x${request.rows}`)),
      disconnect: (ptyId) => Effect.sync(() => calls.push(`disconnect:${ptyId}`)),
      reconnect: (ptyId) => Effect.sync(() => calls.push(`reconnect:${ptyId}`)),
    }),
  )
  return { calls, layer: ptyLayer.pipe(Layer.provide(Layer.merge(repository, driver))) }
}

const create = { ptyId: "pty-1", command: "bun test", cwd: "/workspace", cols: 80, rows: 24 } as const

describe("PTY manager", () => {
  it.effect("creates idempotently and preserves the process across disconnect and cursor reconnect", () => {
    const test = harness()
    return Effect.gen(function* () {
      const pty = yield* Manager
      expect(yield* pty.create(create)).toMatchObject({ ptyId: "pty-1", connected: true, cursor: 0 })
      expect(yield* pty.create(create)).toMatchObject({ ptyId: "pty-1", connected: true, cursor: 0 })
      yield* pty.input({ ptyId: "pty-1", data: "a" })
      yield* pty.recordOutput("pty-1", "first")
      yield* pty.recordOutput("pty-1", "second")
      expect(yield* pty.resize({ ptyId: "pty-1", cols: 120, rows: 40 })).toMatchObject({ cursor: 2 })
      yield* pty.resize({ ptyId: "pty-1", cols: 120, rows: 40 })
      expect(yield* pty.disconnect("pty-1")).toMatchObject({ connected: false, cursor: 2 })
      yield* pty.disconnect("pty-1")
      const disconnectedInput = yield* Effect.flip(pty.input({ ptyId: "pty-1", data: "b" }))
      expect(disconnectedInput.kind).toBe("protocol")
      yield* pty.recordOutput("pty-1", "third")
      expect(yield* pty.reconnect({ ptyId: "pty-1", cursor: 1 })).toEqual({
        ptyId: "pty-1",
        connected: true,
        cursor: 3,
        transcript: [
          { cursor: 2, data: "second" },
          { cursor: 3, data: "third" },
        ],
      })
      expect(test.calls).toEqual(["create:pty-1", "input:a", "resize:120x40", "disconnect:pty-1", "reconnect:pty-1"])
    }).pipe(provideLayer(test.layer))
  })

  it.effect("rejects conflicting create and transcript cursors ahead of durable output", () => {
    const test = harness()
    return Effect.gen(function* () {
      const pty = yield* Manager
      yield* pty.create(create)
      expect((yield* Effect.flip(pty.create({ ...create, command: "bash" }))).kind).toBe("conflict")
      expect((yield* Effect.flip(pty.reconnect({ ptyId: "pty-1", cursor: 1 }))).kind).toBe("protocol")
    }).pipe(provideLayer(test.layer))
  })
})
