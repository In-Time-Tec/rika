import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Diagnostics, Time } from "@rika/core"
import { OrbChanges, OrbPty } from "@rika/orb"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { HttpServer, PresenceHub, RemoteControl } from "../src/index"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe("orb PTY WebSocket", () => {
  test("is orb-only, authenticates with query token, and pipes binary frames through the PTY", async () => {
    const writes: Array<string> = []
    const resizes: Array<{ readonly cols: number; readonly rows: number }> = []
    const pty = OrbPty.testLayer({
      open: (input) =>
        Effect.succeed({
          write: (bytes) =>
            Effect.sync(() => {
              const text = decoder.decode(bytes)
              writes.push(text)
              return Effect.runPromise(input.onData(encoder.encode(`pty:${text}`)))
            }).pipe(Effect.asVoid),
          resize: (cols, rows) =>
            Effect.sync(() => {
              resizes.push({ cols, rows })
            }),
          close: Effect.void,
        }),
    })
    const runtime = ManagedRuntime.make(makeLayer(pty))
    let disabled: HttpServer.ServerHandle | undefined
    let enabled: HttpServer.ServerHandle | undefined

    try {
      disabled = await runtime.runPromise(HttpServer.serve({ port: 0, token: "secret" }))
      const disabledResponse = await fetch(`${disabled.url}/v1/orb/pty?token=secret`)

      enabled = await runtime.runPromise(
        HttpServer.serve({
          port: 0,
          token: "secret",
          orb: true,
          workspace_root: "/workspace/rika",
          base_commit: "abc123",
        }),
      )
      const unauthorized = await fetch(`${enabled.url}/v1/orb/pty`)
      const socket = await connect(`${toWsUrl(enabled.url)}/v1/orb/pty?token=secret`)

      socket.send(encoder.encode("echo hi\n"))
      const first = await nextMessage(socket)
      socket.send(JSON.stringify({ type: "resize", cols: 100, rows: 40 }))
      socket.send(encoder.encode("after resize\n"))
      const second = await nextMessage(socket)
      socket.close()

      expect(disabledResponse.status).toBe(404)
      expect(unauthorized.status).toBe(401)
      expect(decodeMessage(first)).toBe("pty:echo hi\n")
      expect(decodeMessage(second)).toBe("pty:after resize\n")
      expect(writes).toEqual(["echo hi\n", "after resize\n"])
      expect(resizes).toEqual([{ cols: 100, rows: 40 }])
    } finally {
      if (disabled !== undefined) await runtime.runPromise(disabled.close())
      if (enabled !== undefined) await runtime.runPromise(enabled.close())
      await runtime.dispose()
    }
  })

  test("closes a PTY session that finishes opening after the WebSocket has closed", async () => {
    let releaseOpen: (() => void) | undefined
    let openStarted: (() => void) | undefined
    let closes = 0
    const opened = new Promise<void>((resolve) => {
      openStarted = resolve
    })
    const pty = OrbPty.testLayer({
      open: () =>
        Effect.promise(
          () =>
            new Promise<OrbPty.Session>((resolve) => {
              openStarted?.()
              releaseOpen = () =>
                resolve({
                  write: () => Effect.void,
                  resize: () => Effect.void,
                  close: Effect.sync(() => {
                    closes += 1
                  }),
                })
            }),
        ),
    })
    const runtime = ManagedRuntime.make(makeLayer(pty))
    let handle: HttpServer.ServerHandle | undefined
    let socket: WebSocket | undefined

    try {
      handle = await runtime.runPromise(
        HttpServer.serve({
          port: 0,
          token: "secret",
          orb: true,
          workspace_root: "/workspace/rika",
          base_commit: "abc123",
        }),
      )
      socket = await connect(`${toWsUrl(handle.url)}/v1/orb/pty?token=secret`)
      await opened
      socket.close()
      await Bun.sleep(50)

      releaseOpen?.()
      await waitFor(() => closes === 1, "delayed PTY close")

      expect(closes).toBe(1)
    } finally {
      if (socket !== undefined) await closeSocket(socket)
      if (handle !== undefined) await runtime.runPromise(handle.close())
      await runtime.dispose()
    }
  })

  test("runs a real tmux PTY locally and reconnects to the same session", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-server-pty-workspace-"))
    const tmuxDir = await mkdtemp(join(tmpdir(), "rika-server-pty-tmux-"))
    const previousTmuxDir = process.env.TMUX_TMPDIR
    const previousTmux = process.env.TMUX
    process.env.TMUX_TMPDIR = tmuxDir
    delete process.env.TMUX

    const runtime = ManagedRuntime.make(makeLayer(OrbPty.layerFromEnv(process.env)))
    let handle: HttpServer.ServerHandle | undefined
    let first: WebSocket | undefined
    let second: WebSocket | undefined

    try {
      handle = await runtime.runPromise(
        HttpServer.serve({
          port: 0,
          token: "secret",
          orb: true,
          workspace_root: workspace,
          base_commit: "abc123",
        }),
      )

      first = await connect(`${toWsUrl(handle.url)}/v1/orb/pty?token=secret`)
      first.send(encoder.encode("printf 'R1:%s\\n' hi\r"))
      const firstOutput = await waitForText(first, "R1:hi")
      first.send(JSON.stringify({ type: "resize", cols: 100, rows: 40 }))
      first.send(encoder.encode("export RIKA_PTY_RECONNECT=kept; printf 'R2:%s\\n' \"$RIKA_PTY_RECONNECT\"\r"))
      await waitForText(first, "R2:kept")
      first.send(encoder.encode("printf 'R3:%s\\n' after-resize\r"))
      const resizedOutput = await waitForText(first, "R3:after-resize")
      await closeSocket(first)

      second = await connect(`${toWsUrl(handle.url)}/v1/orb/pty?token=secret`)
      second.send(encoder.encode("printf 'R4:%s\\n' \"$RIKA_PTY_RECONNECT\"\r"))
      const reconnectOutput = await waitForText(second, "R4:kept")

      expect(firstOutput).toContain("R1:hi")
      expect(resizedOutput).toContain("R3:after-resize")
      expect(reconnectOutput).toContain("R4:kept")
    } finally {
      if (second !== undefined) await closeSocket(second)
      if (first !== undefined) await closeSocket(first)
      await runTmux(tmuxDir, ["kill-session", "-t", "rika"])
      if (handle !== undefined) await runtime.runPromise(handle.close())
      await runtime.dispose()
      if (previousTmuxDir === undefined) {
        delete process.env.TMUX_TMPDIR
      } else {
        process.env.TMUX_TMPDIR = previousTmuxDir
      }
      if (previousTmux === undefined) {
        delete process.env.TMUX
      } else {
        process.env.TMUX = previousTmux
      }
      await rm(workspace, { force: true, recursive: true })
      await rm(tmuxDir, { force: true, recursive: true })
    }
  }, 20_000)
})

const makeLayer = (pty: Layer.Layer<OrbPty.Service>) =>
  HttpServer.layerWithOrbChanges(
    OrbChanges.testLayer({
      changes: () => Effect.succeed({ base_commit: "abc123", head_commit: "abc123", diff: "", dirty: false }),
    }),
  ).pipe(
    Layer.provideMerge(pty),
    Layer.provideMerge(remoteLayer),
    Layer.provideMerge(PresenceHub.layer.pipe(Layer.provideMerge(Time.layer))),
    Layer.provideMerge(Diagnostics.memoryLayer([])),
  )

const remoteLayer = Layer.succeed(
  RemoteControl.Service,
  RemoteControl.Service.of({
    backendHealth: () =>
      Effect.succeed({
        status: "healthy",
        url: "http://rika.test",
        workspace_root: "/workspace/rika",
        data_dir: "/workspace/rika/.rika",
        backend_id: "test",
        version: "0.0.0",
      }),
    createThread: () => unexpected("createThread"),
    createOrbThread: () => unexpected("createOrbThread"),
    listOrbs: () => unexpected("listOrbs"),
    getOrbByThread: () => unexpected("getOrbByThread"),
    pauseOrb: () => unexpected("pauseOrb"),
    resumeOrb: () => unexpected("resumeOrb"),
    killOrb: () => unexpected("killOrb"),
    listProjects: () => unexpected("listProjects"),
    createProject: () => unexpected("createProject"),
    getProject: () => unexpected("getProject"),
    updateProject: () => unexpected("updateProject"),
    setProjectSecret: () => unexpected("setProjectSecret"),
    deleteProjectSecret: () => unexpected("deleteProjectSecret"),
    listThreads: () => Effect.succeed([]),
    openThread: () => unexpected("openThread"),
    previewThread: () => unexpected("previewThread"),
    archiveThread: () => unexpected("archiveThread"),
    unarchiveThread: () => unexpected("unarchiveThread"),
    compactThread: () => unexpected("compactThread"),
    forkThread: () => unexpected("forkThread"),
    searchThreads: () => unexpected("searchThreads"),
    shareThread: () => unexpected("shareThread"),
    referenceThread: () => unexpected("referenceThread"),
    subscribeThreadEvents: () => Stream.empty,
    setThreadPresence: () => unexpected("setThreadPresence"),
    startTurn: () => unexpected("startTurn"),
    interruptTurn: () => unexpected("interruptTurn"),
    listArtifacts: () => unexpected("listArtifacts"),
    getArtifact: () => unexpected("getArtifact"),
    connectIde: () => unexpected("connectIde"),
    disconnectIde: () => unexpected("disconnectIde"),
    updateIdeContext: () => unexpected("updateIdeContext"),
    ideStatus: () => unexpected("ideStatus"),
    openIdeFile: () => unexpected("openIdeFile"),
    ideNavigationRequests: () => unexpected("ideNavigationRequests"),
  }),
)

const unexpected = <A>(operation: string): Effect.Effect<A, RemoteControl.RemoteControlError> =>
  Effect.fail(new RemoteControl.RemoteControlError({ message: `unexpected ${operation}`, operation, status: 500 }))

const connect = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.binaryType = "arraybuffer"
    socket.addEventListener("open", () => resolve(socket), { once: true })
    socket.addEventListener("error", () => reject(new Error(`websocket failed: ${url}`)), { once: true })
    socket.addEventListener("close", () => reject(new Error(`websocket closed before open: ${url}`)), { once: true })
  })

const nextMessage = (socket: WebSocket) =>
  new Promise<MessageEvent>((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(event), { once: true })
    socket.addEventListener("error", () => reject(new Error("websocket failed while waiting for message")), {
      once: true,
    })
  })

const waitForText = (socket: WebSocket, text: string) =>
  new Promise<string>((resolve, reject) => {
    let seen = ""
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for ${text}; saw ${seen}`))
    }, 5_000)
    const cleanup = () => {
      clearTimeout(timeout)
      socket.removeEventListener("message", onMessage)
      socket.removeEventListener("error", onError)
    }
    const onMessage = (event: MessageEvent) => {
      seen += decodeMessage(event)
      if (seen.includes(text)) {
        cleanup()
        resolve(seen)
      }
    }
    const onError = () => {
      cleanup()
      reject(new Error("websocket failed while waiting for text"))
    }
    socket.addEventListener("message", onMessage)
    socket.addEventListener("error", onError, { once: true })
  })

const decodeMessage = (event: MessageEvent) =>
  typeof event.data === "string"
    ? event.data
    : event.data instanceof ArrayBuffer
      ? decoder.decode(event.data)
      : event.data instanceof Uint8Array
        ? decoder.decode(event.data)
        : String(event.data)

const toWsUrl = (url: string) => url.replace(/^http:/, "ws:").replace(/^https:/, "wss:")

const closeSocket = (socket: WebSocket) =>
  new Promise<void>((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    const timeout = setTimeout(() => resolve(), 500)
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
    socket.close()
  })

const waitFor = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const runTmux = async (tmuxDir: string, args: ReadonlyArray<string>) => {
  const subprocess = Bun.spawn(["tmux", ...args], {
    env: { ...process.env, TMUX_TMPDIR: tmuxDir },
    stdout: "pipe",
    stderr: "pipe",
  })
  await subprocess.exited
}
