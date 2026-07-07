import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Ids } from "@rika/schema"
import type { ITerminalCore } from "ghostty-web"
import { mountOrbTerminal, orbPtyWebSocketUrl, type OrbTerminalRuntime } from "../src/orb-terminal"

const threadId = Ids.ThreadId.make("thread_web_terminal")

describe("orb terminal adapter", () => {
  beforeEach(() => {
    GlobalRegistrator.register({ url: "http://localhost:4590", width: 1280, height: 720 })
  })

  afterEach(async () => {
    await GlobalRegistrator.unregister()
  })

  test("connects Ghostty to the thread PTY and forwards user input as binary frames", async () => {
    const runtime = fakeRuntime()
    const statuses: Array<string> = []
    const errors: Array<string> = []
    const handle = mountOrbTerminal(
      {
        container: document.createElement("div"),
        thread_id: threadId,
        onStatus: (status) => statuses.push(status),
        onError: (message) => errors.push(message),
      },
      runtime,
    )

    await handle.activate()
    const socket = runtime.sockets[0]
    if (socket === undefined) throw new Error("missing socket")
    socket.open()
    runtime.terminal.emitData("abc")

    expect(runtime.initCalls).toBe(1)
    expect(runtime.terminal.opened).toBe(true)
    expect(runtime.fit.fitCalls).toBe(1)
    expect(runtime.fit.observeResizeCalls).toBe(1)
    expect(socket.url).toBe(
      "ws://localhost:4590/api/rika/orb/by-thread/thread_web_terminal/v1/orb/pty?cols=101&rows=31",
    )
    expect(socket.binaryType).toBe("arraybuffer")
    expect(socket.sent).toHaveLength(1)
    expect(socket.sent[0]).toBeInstanceOf(Uint8Array)
    expectBytes(socket.sent[0], [97, 98, 99])
    expect(statuses).toEqual(["connecting", "connected"])
    expect(errors).toEqual([])
  })

  test("sends resize controls as JSON strings and writes PTY output into Ghostty", async () => {
    const runtime = fakeRuntime()
    const handle = mountOrbTerminal(
      {
        container: document.createElement("div"),
        thread_id: threadId,
        onStatus: () => undefined,
        onError: () => undefined,
      },
      runtime,
    )

    await handle.activate()
    const socket = runtime.sockets[0]
    if (socket === undefined) throw new Error("missing socket")
    socket.open()
    runtime.terminal.emitResize(120, 40)
    socket.message(new Uint8Array([104, 105]).buffer)
    socket.message("done")

    expect(socket.sent).toEqual([JSON.stringify({ type: "resize", cols: 120, rows: 40 })])
    expect(runtime.terminal.writes).toEqual([new Uint8Array([104, 105]), "done"])
  })

  test("reconnect disposes old terminal subscriptions before opening a new socket", async () => {
    const runtime = fakeRuntime()
    const handle = mountOrbTerminal(
      {
        container: document.createElement("div"),
        thread_id: threadId,
        onStatus: () => undefined,
        onError: () => undefined,
      },
      runtime,
    )

    await handle.activate()
    const first = runtime.sockets[0]
    if (first === undefined) throw new Error("missing first socket")
    first.open()
    await handle.reconnect()
    const second = runtime.sockets[1]
    if (second === undefined) throw new Error("missing second socket")
    second.open()
    await handle.reconnect()
    const third = runtime.sockets[2]
    if (third === undefined) throw new Error("missing third socket")
    third.open()
    runtime.terminal.emitData("x")

    expect(first.closeCalls).toBe(1)
    expect(second.closeCalls).toBe(1)
    expect(first.sent).toEqual([])
    expect(second.sent).toEqual([])
    expect(third.sent).toHaveLength(1)
    expectBytes(third.sent[0], [120])
  })

  test("auto-reconnects after an unexpected socket close", async () => {
    const runtime = fakeRuntime()
    const statuses: Array<string> = []
    const handle = mountOrbTerminal(
      {
        container: document.createElement("div"),
        thread_id: threadId,
        onStatus: (status) => statuses.push(status),
        onError: () => undefined,
      },
      runtime,
    )

    await handle.activate()
    const first = runtime.sockets[0]
    if (first === undefined) throw new Error("missing first socket")
    first.open()
    first.close()
    await waitFor(() => runtime.sockets.length >= 2, "auto reconnect socket")
    const second = runtime.sockets[1]
    if (second === undefined) throw new Error("missing second socket")
    second.open()
    runtime.terminal.emitData("x")

    expect(first.closeCalls).toBe(1)
    expect(second.sent).toHaveLength(1)
    expectBytes(second.sent[0], [120])
    expect(statuses).toEqual(["connecting", "connected", "disconnected", "connecting", "connected"])

    handle.destroy()
  })

  test("does not auto-reconnect after a normal PTY exit close", async () => {
    const runtime = fakeRuntime()
    const statuses: Array<string> = []
    const handle = mountOrbTerminal(
      {
        container: document.createElement("div"),
        thread_id: threadId,
        onStatus: (status) => statuses.push(status),
        onError: () => undefined,
      },
      runtime,
    )

    await handle.activate()
    const socket = runtime.sockets[0]
    if (socket === undefined) throw new Error("missing socket")
    socket.open()
    socket.close(1000, "pty process exited")
    await Bun.sleep(350)

    expect(runtime.sockets).toHaveLength(1)
    expect(statuses).toEqual(["connecting", "connected", "disconnected"])

    handle.destroy()
  })

  test("builds the browser PTY WebSocket URL without exposing orb credentials", () => {
    expect(
      orbPtyWebSocketUrl({
        thread_id: threadId,
        cols: 90,
        rows: 25,
        location: { protocol: "https:", host: "rika.local" },
      }),
    ).toBe("wss://rika.local/api/rika/orb/by-thread/thread_web_terminal/v1/orb/pty?cols=90&rows=25")
  })
})

interface FakeRuntime extends OrbTerminalRuntime {
  initCalls: number
  readonly terminal: FakeTerminal
  readonly fit: FakeFitAddon
  readonly sockets: Array<FakeSocket>
}

const fakeRuntime = (): FakeRuntime => {
  const runtime: FakeRuntime = {
    initCalls: 0,
    terminal: new FakeTerminal(),
    fit: new FakeFitAddon(),
    sockets: [],
    location: { protocol: "http:", host: "localhost:4590" },
    init: async () => {
      runtime.initCalls += 1
    },
    createTerminal: () => runtime.terminal,
    createFitAddon: () => runtime.fit,
    createWebSocket: (url) => {
      const socket = new FakeSocket(url)
      runtime.sockets.push(socket)
      return socket
    },
  }
  return runtime
}

class FakeTerminal {
  readonly cols = 101
  readonly rows = 31
  readonly writes: Array<string | Uint8Array> = []
  private dataHandlers: Array<(data: string) => void> = []
  private resizeHandlers: Array<(size: { readonly cols: number; readonly rows: number }) => void> = []
  opened = false

  loadAddon(_addon: unknown) {}

  open(_container: HTMLElement) {
    this.opened = true
  }

  onData(handler: (data: string) => void) {
    this.dataHandlers.push(handler)
    return {
      dispose: () => {
        this.dataHandlers = this.dataHandlers.filter((candidate) => candidate !== handler)
      },
    }
  }

  onResize(handler: (size: { readonly cols: number; readonly rows: number }) => void) {
    this.resizeHandlers.push(handler)
    return {
      dispose: () => {
        this.resizeHandlers = this.resizeHandlers.filter((candidate) => candidate !== handler)
      },
    }
  }

  write(data: string | Uint8Array) {
    this.writes.push(data)
  }

  focus() {}

  dispose() {}

  emitData(data: string) {
    for (const handler of this.dataHandlers) handler(data)
  }

  emitResize(cols: number, rows: number) {
    for (const handler of this.resizeHandlers) handler({ cols, rows })
  }
}

class FakeFitAddon {
  fitCalls = 0
  observeResizeCalls = 0

  activate(_terminal: ITerminalCore) {}

  fit() {
    this.fitCalls += 1
  }

  observeResize() {
    this.observeResizeCalls += 1
  }

  dispose() {}
}

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  binaryType: BinaryType = "blob"
  readyState = FakeSocket.CONNECTING
  closeCalls = 0
  readonly sent: Array<string | Uint8Array> = []
  readonly listeners = new Map<
    string,
    Array<(event: { readonly data?: unknown; readonly code?: number; readonly reason?: string }) => void>
  >()

  constructor(readonly url: string) {}

  send(data: string | Uint8Array) {
    this.sent.push(data)
  }

  close(code?: number, reason?: string) {
    this.closeCalls += 1
    this.readyState = FakeSocket.CLOSED
    this.dispatch("close", { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) })
  }

  open() {
    this.readyState = FakeSocket.OPEN
    this.dispatch("open", {})
  }

  message(data: unknown) {
    this.dispatch("message", { data })
  }

  addEventListener(
    event: string,
    listener: (event: { readonly data?: unknown; readonly code?: number; readonly reason?: string }) => void,
  ) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }

  removeEventListener(
    event: string,
    listener: (event: { readonly data?: unknown; readonly code?: number; readonly reason?: string }) => void,
  ) {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
    )
  }

  private dispatch(
    event: string,
    payload: { readonly data?: unknown; readonly code?: number; readonly reason?: string },
  ) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
  }
}

const expectBytes = (value: unknown, expected: ReadonlyArray<number>) => {
  if (!(value instanceof Uint8Array)) throw new Error("expected Uint8Array")
  expect(Array.from(value)).toEqual([...expected])
}

const waitFor = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}
