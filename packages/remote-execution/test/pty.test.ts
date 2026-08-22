import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer } from "effect"
import {
  detectCapabilities,
  Driver,
  Manager,
  PtyError,
  Repository,
  TranscriptLimit,
  layer as ptyLayer,
  repositoryLayer,
  testing,
  type Record,
} from "../src/pty"
import type { Fence } from "../src/protocol"
import { provideLayer } from "./support/layer"

const fence: Fence = {
  target: "orb",
  assignmentId: "assignment-1",
  assignmentGeneration: 3,
  instanceId: "sandbox-3",
  executorId: "executor-3:process-3",
  processIncarnation: "process-3",
}

const harness = () => {
  const records = new Map<string, Record>()
  const calls: Array<string> = []
  const processes = new Set<string>()
  const outputs = new Map<string, (ptyId: string, data: string) => Effect.Effect<void, PtyError>>()
  const exits = new Map<string, (ptyId: string) => Effect.Effect<void, PtyError>>()
  const repository = Layer.succeed(
    Repository,
    Repository.of({
      get: (ptyId) => Effect.succeed(records.get(ptyId)),
      list: Effect.sync(() => [...records.values()]),
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
      create: (request, output, exit) =>
        Effect.sync(() => {
          calls.push(`create:${request.ptyId}`)
          processes.add(request.ptyId)
          outputs.set(request.ptyId, output)
          exits.set(request.ptyId, exit)
        }),
      input: (request) => Effect.sync(() => calls.push(`input:${request.data}`)),
      resize: (request) => Effect.sync(() => calls.push(`resize:${request.cols}x${request.rows}`)),
      reconnect: (ptyId, output, exit) =>
        processes.has(ptyId)
          ? Effect.sync(() => {
              calls.push(`reconnect:${ptyId}`)
              outputs.set(ptyId, output)
              exits.set(ptyId, exit)
            })
          : Effect.fail(PtyError.make({ kind: "missing", message: "process missing" })),
      terminate: (ptyId) =>
        Effect.sync(() => {
          calls.push(`terminate:${ptyId}`)
          processes.delete(ptyId)
        }),
    }),
  )
  return {
    calls,
    processes,
    output: (data: string) => outputs.get("pty-1")!("pty-1", data),
    exit: () => exits.get("pty-1")!("pty-1"),
    layer: ptyLayer.pipe(Layer.provide(Layer.merge(repository, driver))),
  }
}

const create = { ptyId: "pty-1", command: "bun test", cwd: "/workspace", cols: 80, rows: 24 } as const

describe("PTY manager", () => {
  it.effect("keeps the tmux process alive across logical detach and replays output in cursor order", () => {
    const test = harness()
    return Effect.gen(function* () {
      const pty = yield* Manager
      expect(yield* pty.create(create)).toMatchObject({ ptyId: "pty-1", connected: true, cursor: 0 })
      expect(yield* pty.create(create)).toMatchObject({ ptyId: "pty-1", connected: true, cursor: 0 })
      yield* pty.input({ ptyId: "pty-1", data: "a" })
      yield* test.output("first")
      yield* test.output("second")
      expect(yield* pty.resize({ ptyId: "pty-1", cols: 120, rows: 40 })).toMatchObject({ cursor: 2 })
      yield* pty.resize({ ptyId: "pty-1", cols: 120, rows: 40 })
      expect(yield* pty.create(create)).toMatchObject({ cols: 120, rows: 40 })
      expect(yield* pty.disconnect("pty-1")).toMatchObject({ connected: false, cursor: 2 })
      expect(test.processes.has("pty-1")).toBe(true)
      expect(test.calls).not.toContain("terminate:pty-1")
      expect((yield* Effect.flip(pty.input({ ptyId: "pty-1", data: "b" }))).kind).toBe("protocol")
      yield* test.output("third")
      expect(yield* pty.reconnect({ ptyId: "pty-1", cursor: 1 })).toMatchObject({
        ptyId: "pty-1",
        connected: true,
        cursor: 3,
        gap: null,
        transcript: [
          { cursor: 2, data: "second" },
          { cursor: 3, data: "third" },
        ],
      })
      expect(test.calls).toEqual([
        "create:pty-1",
        "reconnect:pty-1",
        "input:a",
        "resize:120x40",
        "reconnect:pty-1",
        "reconnect:pty-1",
      ])
    }).pipe(provideLayer(test.layer))
  })

  it.effect("bounds retained output, reports a replay gap, and rejects cursors ahead of output", () => {
    const test = harness()
    return Effect.gen(function* () {
      const pty = yield* Manager
      yield* pty.create(create)
      for (let index = 1; index <= TranscriptLimit + 2; index += 1) yield* test.output(String(index))
      yield* pty.disconnect("pty-1")
      expect(yield* pty.reconnect({ ptyId: "pty-1", cursor: 0 })).toMatchObject({
        cursor: TranscriptLimit + 2,
        gap: { fromCursor: 1, toCursor: 2 },
      })
      const replay = yield* pty.reconnect({ ptyId: "pty-1", cursor: TranscriptLimit })
      expect(replay.transcript).toEqual([
        { cursor: TranscriptLimit + 1, data: String(TranscriptLimit + 1) },
        { cursor: TranscriptLimit + 2, data: String(TranscriptLimit + 2) },
      ])
      expect((yield* Effect.flip(pty.reconnect({ ptyId: "pty-1", cursor: TranscriptLimit + 3 }))).kind).toBe("protocol")
    }).pipe(provideLayer(test.layer))
  })

  it.effect("terminates only on an explicit request and does not duplicate termination", () => {
    const test = harness()
    return Effect.gen(function* () {
      const pty = yield* Manager
      yield* pty.create(create)
      expect(yield* pty.terminate("pty-1")).toMatchObject({ connected: false, terminated: true })
      expect(yield* pty.terminate("pty-1")).toMatchObject({ connected: false, terminated: true })
      expect(test.processes.has("pty-1")).toBe(false)
      expect(test.calls).toEqual(["create:pty-1", "terminate:pty-1"])
      expect((yield* Effect.flip(pty.reconnect({ ptyId: "pty-1", cursor: 0 }))).kind).toBe("protocol")
    }).pipe(provideLayer(test.layer))
  })

  it.effect("rejects a conflicting create and records a naturally exited process", () => {
    const test = harness()
    return Effect.gen(function* () {
      const pty = yield* Manager
      yield* pty.create(create)
      expect((yield* Effect.flip(pty.create({ ...create, command: "bash" }))).kind).toBe("conflict")
      yield* test.exit()
      expect((yield* Effect.flip(pty.input({ ptyId: "pty-1", data: "x" }))).kind).toBe("protocol")
    }).pipe(provideLayer(test.layer))
  })
})

describe("PTY durable state and image capabilities", () => {
  it.effect("persists assignment-scoped transcript state outside the Workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(BunServices.layer)
        const fileSystem = Context.get(services, FileSystem.FileSystem)
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-pty-state-" })
        const repository = yield* Layer.build(repositoryLayer({ stateDirectory: directory, fence })).pipe(
          Effect.provide(services),
        )
        const store = Context.get(repository, Repository)
        yield* store.insert({
          ...create,
          connected: false,
          terminated: false,
          cursor: 1,
          transcript: [{ cursor: 1, data: "durable" }],
          revision: 0,
        })
        const restored = yield* Layer.build(repositoryLayer({ stateDirectory: directory, fence })).pipe(
          Effect.provide(services),
        )
        expect(yield* Context.get(restored, Repository).get("pty-1")).toMatchObject({
          cursor: 1,
          transcript: [{ cursor: 1, data: "durable" }],
        })
        expect((yield* fileSystem.stat(`${directory}/pty`)).mode & 0o777).toBe(0o700)
      }),
    ),
  )

  it.effect("detects PTY, browser, and repository-service capabilities independently", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      expect(
        yield* detectCapabilities((command, args) => {
          calls.push(`${command} ${args.join(" ")}`)
          return Effect.succeed(true)
        }),
      ).toEqual({ cells: true, checkpoints: false, pty: true, browser: true, services: true })
      expect(calls).toEqual(["tmux -V", "chromium --version", "agent-browser --version", "true "])
      expect(yield* detectCapabilities((command) => Effect.succeed(command === "tmux" || command === "true"))).toEqual({
        cells: true,
        checkpoints: false,
        pty: true,
        browser: false,
        services: true,
      })
      expect(
        yield* detectCapabilities((command) => Effect.succeed(command === "chromium" || command === "agent-browser")),
      ).toEqual({ cells: true, checkpoints: false, pty: false, browser: true, services: false })
    }),
  )

  it("decodes ordered tmux control-mode output without a shell parser", () => {
    expect(testing.controlOutput("%output %0 first\\015\\012second")).toBe("first\r\nsecond")
    expect(testing.controlOutput("%output %0 path\\\\name")).toBe("path\\name")
    expect(testing.controlOutput("%session-changed $0 pty")).toBeUndefined()
  })
})
