import { describe, expect, test } from "bun:test"
import { Config } from "@rika/core"
import { OrbActivity } from "@rika/orb"
import { Ids } from "@rika/schema"
import { Effect, Layer } from "effect"
import { BackendEndpoint, OrbShell } from "../src/index"

const threadId = Ids.ThreadId.make("thread_orb_shell")
const orbId = Ids.OrbId.make("orb_shell")

describe("CLI orb shell", () => {
  test("resolves an orb endpoint, runs the PTY system, and touches activity on open and input", async () => {
    const runs: Array<string> = []
    const touches: Array<Ids.OrbId> = []

    const exitCode = await Effect.runPromise(
      OrbShell.shell(threadId).pipe(
        Effect.provide(
          OrbShell.layerFromEnv({}).pipe(
            Layer.provideMerge(configLayer),
            Layer.provideMerge(resolverLayer),
            Layer.provideMerge(activityLayer(touches)),
            Layer.provideMerge(
              OrbShell.systemTestLayer({
                run: (input) =>
                  Effect.gen(function* () {
                    runs.push(input.url)
                    yield* input.onOpen
                    yield* input.onInput
                  }),
              }),
            ),
          ),
        ),
      ),
    )

    expect(exitCode).toBe(0)
    expect(runs).toEqual(["wss://orb.cli.test/v1/orb/pty?token=orb-token"])
    expect(touches).toEqual([orbId, orbId])
  })

  test("system forwards terminal IO, sends resize controls, and restores prior raw mode", async () => {
    const socket = new FakeSocket()
    const stdin = new FakeStdin(true)
    const stdout = new FakeStdout(120, 40)
    const signals = new FakeSignals()
    let now = 1_000
    let opens = 0
    let inputs = 0

    const run = Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* OrbShell.System
        return yield* system.run({
          url: "ws://orb.cli.test/v1/orb/pty?token=orb-token",
          onOpen: Effect.sync(() => {
            opens += 1
          }),
          onInput: Effect.sync(() => {
            inputs += 1
          }),
        })
      }).pipe(
        Effect.provide(
          OrbShell.systemLayerWithPlatform({
            stdin,
            stdout,
            signals,
            openWebSocket: () => socket,
            now: () => now,
          }),
        ),
      ),
    )

    socket.open()
    await Bun.sleep(0)
    expect(opens).toBe(1)
    expect(stdin.rawModes).toEqual([true])
    expect(socket.sent[0]).toBe(JSON.stringify({ type: "resize", cols: 120, rows: 40 }))

    stdout.columns = 100
    stdout.rows = 30
    signals.emit("SIGWINCH")
    expect(socket.sent[1]).toBe(JSON.stringify({ type: "resize", cols: 100, rows: 30 }))

    socket.message(new Uint8Array([65, 66]))
    expect(stdout.writes).toEqual([new Uint8Array([65, 66])])

    now = 31_000
    stdin.emit(Buffer.from("abc"))
    expect(socket.sent[2]).toEqual(Buffer.from("abc"))
    expect(inputs).toBe(1)

    stdin.emit(Buffer.from([0x1c]))
    await run

    expect(stdin.isRaw).toBe(true)
    expect(stdin.rawModes).toEqual([true, true])
    expect(socket.closeCalls).toBe(1)
    expect(stdin.listenerCount("data")).toBe(0)
    expect(signals.listenerCount("SIGWINCH")).toBe(0)
  })
})

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika",
  data_dir: "/workspace/rika/.rika",
  default_mode: "smart",
})

const resolverLayer = Layer.succeed(
  BackendEndpoint.Resolver,
  BackendEndpoint.Resolver.of({
    resolveEndpoint: () =>
      Effect.succeed({
        kind: "orb",
        url: "https://orb.cli.test",
        token: "orb-token",
        orb_id: orbId,
        thread_id: threadId,
      }),
  }),
)

const activityLayer = (touches: Array<Ids.OrbId>) =>
  Layer.succeed(
    OrbActivity.Service,
    OrbActivity.Service.of({
      touch: (id) =>
        Effect.sync(() => {
          touches.push(id)
        }),
      release: () => Effect.void,
    }),
  )

class FakeSocket {
  binaryType = ""
  readyState: number = WebSocket.CONNECTING
  readonly sent: Array<string | Buffer | Uint8Array> = []
  closeCalls = 0
  readonly listeners = new Map<
    string,
    Array<{ readonly listener: (event: { readonly data?: unknown }) => void; readonly once: boolean }>
  >()

  send(data: string | Buffer | Uint8Array) {
    this.sent.push(data)
  }

  close() {
    this.closeCalls += 1
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    this.dispatch("close", {})
  }

  addEventListener(
    event: string,
    listener: (event: { readonly data?: unknown }) => void,
    options?: AddEventListenerOptions,
  ) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), { listener, once: options?.once === true }])
  }

  open() {
    this.readyState = WebSocket.OPEN
    this.dispatch("open", {})
  }

  message(data: unknown) {
    this.dispatch("message", { data })
  }

  private dispatch(event: string, payload: { readonly data?: unknown }) {
    const listeners = this.listeners.get(event) ?? []
    for (const entry of listeners) entry.listener(payload)
    this.listeners.set(
      event,
      listeners.filter((entry) => !entry.once),
    )
  }
}

class FakeStdin {
  readonly isTTY = true
  readonly rawModes: Array<boolean> = []
  readonly listeners = new Map<string, Array<(chunk: Buffer) => void>>()
  resumeCalls = 0

  constructor(public isRaw: boolean) {}

  setRawMode(value: boolean) {
    this.rawModes.push(value)
    this.isRaw = value
  }

  resume() {
    this.resumeCalls += 1
  }

  on(event: string, listener: (chunk: Buffer) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }

  off(event: string, listener: (chunk: Buffer) => void) {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
    )
  }

  emit(chunk: Buffer) {
    for (const listener of this.listeners.get("data") ?? []) listener(chunk)
  }

  listenerCount(event: string) {
    return this.listeners.get(event)?.length ?? 0
  }
}

class FakeStdout {
  readonly isTTY = true
  readonly writes: Array<string | Uint8Array> = []

  constructor(
    public columns: number,
    public rows: number,
  ) {}

  write(data: string | Uint8Array) {
    this.writes.push(data)
  }
}

class FakeSignals {
  readonly listeners = new Map<string, Array<() => void>>()

  on(event: string, listener: () => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }

  off(event: string, listener: () => void) {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
    )
  }

  emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }

  listenerCount(event: string) {
    return this.listeners.get(event)?.length ?? 0
  }
}
