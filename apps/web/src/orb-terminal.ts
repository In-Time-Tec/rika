import { FitAddon, Terminal, init, type ITerminalAddon } from "ghostty-web"
import type { Ids } from "@rika/schema"

export type OrbTerminalStatus = "idle" | "connecting" | "connected" | "disconnected" | "failed"

export interface OrbTerminalMountInput {
  readonly container: HTMLElement
  readonly thread_id: Ids.ThreadId
  readonly onStatus: (status: OrbTerminalStatus) => void
  readonly onError: (message: string) => void
}

export interface OrbTerminalHandle {
  readonly activate: () => Promise<void>
  readonly reconnect: () => Promise<void>
  readonly destroy: () => void
}

export interface OrbTerminalRuntime {
  readonly location: Pick<Location, "protocol" | "host">
  readonly init: () => Promise<void>
  readonly createTerminal: () => OrbTerminalTerminal
  readonly createFitAddon: () => OrbTerminalFitAddon
  readonly createWebSocket: (url: string) => OrbTerminalWebSocket
}

export interface OrbTerminalTerminal {
  readonly cols: number
  readonly rows: number
  readonly loadAddon: (addon: ITerminalAddon) => void
  readonly open: (container: HTMLElement) => void
  readonly onData: (handler: (data: string) => void) => OrbTerminalDisposable
  readonly onResize: (
    handler: (size: { readonly cols: number; readonly rows: number }) => void,
  ) => OrbTerminalDisposable
  readonly write: (data: string | Uint8Array) => void
  readonly focus?: () => void
  readonly dispose?: () => void
}

export interface OrbTerminalFitAddon extends ITerminalAddon {
  readonly fit: () => void
  readonly observeResize: () => void
}

export interface OrbTerminalDisposable {
  readonly dispose: () => void
}

export interface OrbTerminalWebSocket {
  binaryType: BinaryType
  readonly readyState: number
  readonly send: (data: string | Uint8Array) => void
  readonly close: () => void
  readonly addEventListener: (
    event: "open" | "message" | "error" | "close",
    listener: OrbTerminalWebSocketListener,
  ) => void
  readonly removeEventListener: (
    event: "open" | "message" | "error" | "close",
    listener: OrbTerminalWebSocketListener,
  ) => void
}

export type OrbTerminalWebSocketListener = (event: { readonly data?: unknown }) => void

export interface OrbPtyWebSocketUrlInput {
  readonly thread_id: Ids.ThreadId
  readonly cols: number
  readonly rows: number
  readonly location: Pick<Location, "protocol" | "host">
}

const socketConnecting = 0
const socketOpen = 1
const terminalHandles = new Map<Ids.ThreadId, OrbTerminalHandle>()

export const mountOrbTerminal = (
  input: OrbTerminalMountInput,
  runtime: OrbTerminalRuntime = browserOrbTerminalRuntime(),
): OrbTerminalHandle => {
  let terminal: OrbTerminalTerminal | undefined
  let fitAddon: OrbTerminalFitAddon | undefined
  let socket: OrbTerminalWebSocket | undefined
  let dataSubscription: OrbTerminalDisposable | undefined
  let resizeSubscription: OrbTerminalDisposable | undefined
  let socketListeners: ReadonlyArray<() => void> = []
  let initializing: Promise<void> | undefined
  let destroyed = false

  const cleanupConnection = () => {
    dataSubscription?.dispose()
    resizeSubscription?.dispose()
    for (const remove of socketListeners) remove()
    dataSubscription = undefined
    resizeSubscription = undefined
    socketListeners = []
    const active = socket
    socket = undefined
    if (active !== undefined) {
      if (active.readyState === socketOpen || active.readyState === socketConnecting) active.close()
    }
  }

  const ensureTerminal = async () => {
    if (terminal !== undefined) return
    initializing ??= runtime.init().then(() => {
      if (destroyed) return
      const nextTerminal = runtime.createTerminal()
      const nextFitAddon = runtime.createFitAddon()
      nextTerminal.loadAddon(nextFitAddon)
      nextTerminal.open(input.container)
      nextFitAddon.fit()
      nextFitAddon.observeResize()
      terminal = nextTerminal
      fitAddon = nextFitAddon
    })
    await initializing
  }

  const connect = () => {
    const activeTerminal = terminal
    if (destroyed || activeTerminal === undefined) return
    cleanupConnection()
    input.onStatus("connecting")
    const nextSocket = runtime.createWebSocket(
      orbPtyWebSocketUrl({
        thread_id: input.thread_id,
        cols: activeTerminal.cols,
        rows: activeTerminal.rows,
        location: runtime.location,
      }),
    )
    socket = nextSocket
    nextSocket.binaryType = "arraybuffer"
    dataSubscription = activeTerminal.onData((data) => {
      if (nextSocket.readyState === socketOpen) nextSocket.send(new TextEncoder().encode(data))
    })
    resizeSubscription = activeTerminal.onResize(({ cols, rows }) => {
      if (nextSocket.readyState === socketOpen) nextSocket.send(JSON.stringify({ type: "resize", cols, rows }))
    })
    const onOpen = () => {
      if (socket !== nextSocket || destroyed) return
      input.onStatus("connected")
      activeTerminal.focus?.()
    }
    const onMessage = (event: { readonly data?: unknown }) => {
      if (socket !== nextSocket || destroyed) return
      activeTerminal.write(terminalOutputData(event.data))
    }
    const onError = () => {
      if (socket !== nextSocket || destroyed) return
      input.onStatus("failed")
      input.onError("orb terminal websocket failed")
    }
    const onClose = () => {
      if (socket !== nextSocket || destroyed) return
      input.onStatus("disconnected")
    }
    socketListeners = [
      addSocketListener(nextSocket, "open", onOpen),
      addSocketListener(nextSocket, "message", onMessage),
      addSocketListener(nextSocket, "error", onError),
      addSocketListener(nextSocket, "close", onClose),
    ]
  }

  const activate = async () => {
    try {
      await ensureTerminal()
      connect()
    } catch (cause) {
      if (destroyed) return
      input.onStatus("failed")
      input.onError(errorMessage(cause))
    }
  }

  const handle: OrbTerminalHandle = {
    activate,
    reconnect: activate,
    destroy: () => {
      if (destroyed) return
      destroyed = true
      cleanupConnection()
      terminalHandles.delete(input.thread_id)
      fitAddon?.dispose()
      terminal?.dispose?.()
      input.container.replaceChildren()
    },
  }
  terminalHandles.set(input.thread_id, handle)
  return handle
}

export const reconnectOrbTerminal = (threadId: Ids.ThreadId): boolean => {
  const handle = terminalHandles.get(threadId)
  if (handle === undefined) return false
  void handle.reconnect()
  return true
}

export const orbPtyWebSocketUrl = (input: OrbPtyWebSocketUrlInput): string => {
  const protocol = input.location.protocol === "https:" ? "wss:" : "ws:"
  const url = new URL(
    `/api/rika/orb/by-thread/${encodeURIComponent(input.thread_id)}/v1/orb/pty`,
    `${protocol}//${input.location.host}`,
  )
  url.searchParams.set("cols", String(dimensionOrDefault(input.cols, 80, 1, 500)))
  url.searchParams.set("rows", String(dimensionOrDefault(input.rows, 24, 1, 300)))
  return url.toString()
}

const browserOrbTerminalRuntime = (): OrbTerminalRuntime => ({
  location: window.location,
  init,
  createTerminal: () => new Terminal({ cursorBlink: true, scrollback: 10000 }),
  createFitAddon: () => new FitAddon(),
  createWebSocket: (url) => orbTerminalWebSocket(new WebSocket(url)),
})

export const orbTerminalWebSocket = (socket: WebSocket): OrbTerminalWebSocket => {
  const listeners = new Map<OrbTerminalWebSocketListener, EventListener>()
  return {
    get binaryType() {
      return socket.binaryType
    },
    set binaryType(value: BinaryType) {
      socket.binaryType = value
    },
    get readyState() {
      return socket.readyState
    },
    send: (data) => socket.send(data),
    close: () => socket.close(),
    addEventListener: (event, listener) => {
      const wrapped = (domEvent: Event) => {
        listener({ data: eventData(domEvent) })
      }
      listeners.set(listener, wrapped)
      socket.addEventListener(event, wrapped)
    },
    removeEventListener: (event, listener) => {
      const wrapped = listeners.get(listener)
      if (wrapped === undefined) return
      socket.removeEventListener(event, wrapped)
      listeners.delete(listener)
    },
  }
}

const eventData = (event: Event): unknown => ("data" in event ? event.data : undefined)

const addSocketListener = (
  socket: OrbTerminalWebSocket,
  event: "open" | "message" | "error" | "close",
  listener: OrbTerminalWebSocketListener,
) => {
  socket.addEventListener(event, listener)
  return () => socket.removeEventListener(event, listener)
}

const terminalOutputData = (data: unknown): string | Uint8Array =>
  typeof data === "string"
    ? data
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : data instanceof Uint8Array
        ? data
        : String(data)

const dimensionOrDefault = (value: number, fallback: number, minimum: number, maximum: number) =>
  Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
