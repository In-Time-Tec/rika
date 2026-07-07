import { createServer, type Server } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { describe, expect, test } from "bun:test"
import { Diagnostics, SecretRedactor, Time } from "@rika/core"
import { OrbChanges, OrbPty } from "@rika/orb"
import { Ids } from "@rika/schema"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import type { ITerminalCore } from "ghostty-web"
import { WebSocketServer } from "ws"
import { HttpServer, PresenceHub, RemoteControl } from "@rika/server"
import {
  mountOrbTerminal,
  orbTerminalWebSocket,
  type OrbTerminalHandle,
  type OrbTerminalRuntime,
} from "../src/orb-terminal"
import { proxyOrbPtyWebSocketRequest } from "../vite.config"

const threadId = Ids.ThreadId.make("thread_web_terminal_e2e")

describe("orb terminal web e2e", () => {
  test("runs commands through the web PTY proxy across tab remount and forced reconnect", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-web-terminal-workspace-"))
    const tmuxDir = await mkdtemp(join(tmpdir(), "rika-web-terminal-tmux-"))
    const previousTmuxDir = process.env.TMUX_TMPDIR
    const previousTmux = process.env.TMUX
    const nativeWebSocket = globalThis.WebSocket
    process.env.TMUX_TMPDIR = tmuxDir
    delete process.env.TMUX
    GlobalRegistrator.register({ url: "http://localhost:4590", width: 1280, height: 720 })
    globalThis.WebSocket = nativeWebSocket

    const runtime = ManagedRuntime.make(makeLayer(OrbPty.layerFromEnv(process.env)))
    const proxy = createServer()
    const proxyWss = new WebSocketServer({ noServer: true })
    let orbServer: HttpServer.ServerHandle | undefined
    let firstHandle: OrbTerminalHandle | undefined
    let secondHandle: OrbTerminalHandle | undefined

    try {
      orbServer = await runtime.runPromise(
        HttpServer.serve({
          port: 0,
          token: "secret",
          orb: true,
          workspace_root: workspace,
          base_commit: "abc123",
        }),
      )
      proxy.on("upgrade", (request, socket, head) => {
        void proxyOrbPtyWebSocketRequest(request, socket, head, proxyWss, async (input) => {
          expect(input.thread_id).toBe(threadId)
          if (orbServer === undefined) throw new Error("orb server unavailable")
          return {
            kind: "orb",
            url: orbServer.url,
            token: "secret",
            orb_id: Ids.OrbId.make("orb_web_terminal_e2e"),
            thread_id: threadId,
          }
        })
      })
      await listen(proxy)
      const proxyLocation = locationFromServer(proxy)
      const first = makeRuntime(proxyLocation)
      const firstStatuses: Array<string> = []
      firstHandle = mountOrbTerminal(
        {
          container: document.createElement("div"),
          thread_id: threadId,
          onStatus: (status) => firstStatuses.push(status),
          onError: (message) => firstStatuses.push(message),
        },
        first,
      )
      await firstHandle.activate()
      await waitFor(() => firstStatuses.includes("connected"), "first terminal connected")
      first.terminal.emitData("export RIKA_WEB_PTY=kept; printf 'WEB1:%s\\n' hi\r")
      await waitFor(() => first.terminal.text().includes("WEB1:hi"), "first PTY output")
      firstHandle.destroy()

      const second = makeRuntime(proxyLocation)
      const secondStatuses: Array<string> = []
      secondHandle = mountOrbTerminal(
        {
          container: document.createElement("div"),
          thread_id: threadId,
          onStatus: (status) => secondStatuses.push(status),
          onError: (message) => secondStatuses.push(message),
        },
        second,
      )
      await secondHandle.activate()
      await waitFor(() => secondStatuses.includes("connected"), "second terminal connected")
      second.terminal.emitData("printf 'WEB2:%s\\n' \"$RIKA_WEB_PTY\"\r")
      await waitFor(() => second.terminal.text().includes("WEB2:kept"), "remounted PTY session")

      second.sockets.at(-1)?.close()
      await waitFor(() => secondStatuses.includes("disconnected"), "forced socket close")
      await secondHandle.reconnect()
      await waitFor(() => secondStatuses.filter((status) => status === "connected").length >= 2, "reconnected terminal")
      second.terminal.emitData("printf 'WEB3:%s\\n' \"$RIKA_WEB_PTY\"\r")
      await waitFor(() => second.terminal.text().includes("WEB3:kept"), "reconnected PTY session")

      expect(first.terminal.text()).toContain("WEB1:hi")
      expect(second.terminal.text()).toContain("WEB2:kept")
      expect(second.terminal.text()).toContain("WEB3:kept")
      secondHandle.destroy()
    } finally {
      firstHandle?.destroy()
      secondHandle?.destroy()
      proxyWss.close()
      await closeServer(proxy)
      await runTmux(tmuxDir, ["kill-session", "-t", "rika"])
      if (orbServer !== undefined) await runtime.runPromise(orbServer.close())
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
      await GlobalRegistrator.unregister()
      globalThis.WebSocket = nativeWebSocket
    }
  }, 20_000)
})

const makeRuntime = (location: Pick<Location, "protocol" | "host">) => {
  const terminal = new FakeTerminal()
  const fit = new FakeFitAddon()
  const sockets: Array<WebSocket> = []
  const runtime: OrbTerminalRuntime & {
    readonly terminal: FakeTerminal
    readonly sockets: Array<WebSocket>
  } = {
    location,
    terminal,
    sockets,
    init: async () => undefined,
    createTerminal: () => terminal,
    createFitAddon: () => fit,
    createWebSocket: (url) => {
      const socket = new WebSocket(url)
      socket.binaryType = "arraybuffer"
      sockets.push(socket)
      return orbTerminalWebSocket(socket)
    },
  }
  return runtime
}

class FakeTerminal {
  readonly cols = 100
  readonly rows = 30
  private dataHandlers: Array<(data: string) => void> = []
  private readonly decoder = new TextDecoder()
  private output = ""

  loadAddon(_addon: unknown) {}

  open(_container: HTMLElement) {}

  onData(handler: (data: string) => void) {
    this.dataHandlers.push(handler)
    return {
      dispose: () => {
        this.dataHandlers = this.dataHandlers.filter((candidate) => candidate !== handler)
      },
    }
  }

  onResize(_handler: (size: { readonly cols: number; readonly rows: number }) => void) {
    return { dispose: () => undefined }
  }

  write(data: string | Uint8Array) {
    this.output += typeof data === "string" ? data : this.decoder.decode(data)
  }

  focus() {}

  dispose() {}

  emitData(data: string) {
    for (const handler of this.dataHandlers) handler(data)
  }

  text() {
    return this.output
  }
}

class FakeFitAddon {
  activate(_terminal: ITerminalCore) {}

  fit() {}

  observeResize() {}

  dispose() {}
}

const makeLayer = (pty: Layer.Layer<OrbPty.Service, never, Diagnostics.Service>) => {
  const redactorLayer = SecretRedactor.layer
  const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
  const ptyLayer = pty.pipe(Layer.provideMerge(diagnosticsLayer))
  return HttpServer.layerWithOrbChanges(
    OrbChanges.testLayer({
      changes: () => Effect.succeed({ base_commit: "abc123", head_commit: "abc123", diff: "", dirty: false }),
    }),
  ).pipe(
    Layer.provideMerge(ptyLayer),
    Layer.provideMerge(remoteLayer),
    Layer.provideMerge(PresenceHub.layer.pipe(Layer.provideMerge(Time.layer))),
    Layer.provideMerge(diagnosticsLayer),
  )
}

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
    setThreadVisibility: () => unexpected("setThreadVisibility"),
    compactThread: () => unexpected("compactThread"),
    forkThread: () => unexpected("forkThread"),
    searchThreads: () => unexpected("searchThreads"),
    shareThread: () => unexpected("shareThread"),
    referenceThread: () => unexpected("referenceThread"),
    subscribeThreadEvents: () => Stream.empty,
    subscribeThreadPresence: () => Stream.empty,
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

const listen = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close((error) => {
      if (error === undefined) {
        resolve()
      } else {
        reject(error)
      }
    })
  })

const locationFromServer = (server: Server): Pick<Location, "protocol" | "host"> => {
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("server is not listening on TCP")
  return { protocol: "http:", host: `127.0.0.1:${address.port}` }
}

const waitFor = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(20)
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
