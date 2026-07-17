import { createHash, randomUUID } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import { Effect, Schema } from "effect"
import type { Sandbox } from "./process"

export interface ResidentEvent {
  readonly _tag: string
  readonly [key: string]: unknown
}

export interface ResidentCommandOutcome {
  readonly sequence: number
  readonly failed: boolean
  readonly error?: unknown
}

export interface ResidentCommandClient {
  readonly events: ReadonlyArray<ResidentEvent>
  readonly feedSequences: ReadonlyArray<number>
  readonly command: (command: Readonly<Record<string, unknown>>) => Promise<ResidentCommandOutcome>
  readonly waitFor: (
    predicate: (events: ReadonlyArray<ResidentEvent>) => boolean,
    timeoutMilliseconds?: number,
  ) => Promise<ReadonlyArray<ResidentEvent>>
  readonly close: () => Promise<void>
}

export class ResidentCommandClientError extends Schema.TaggedErrorClass<ResidentCommandClientError>()(
  "ResidentCommandClientError",
  { message: Schema.String },
) {}

const clientFailure = (cause: unknown) => ResidentCommandClientError.make({ message: String(cause) })

const openClient = async (context: Sandbox, threadId: string): Promise<ResidentCommandClient> => {
  const database = context.env.RIKA_DATABASE
  if (database === undefined) throw new Error("RIKA_DATABASE is missing")
  const dataRoot = await realpath(database.slice(0, -"rika.db".length))
  const identity = createHash("sha256").update(`default\0${dataRoot}`).digest("hex")
  const token = (await readFile(`${dataRoot}/resident.token`, "utf8")).trim()
  const port = 20_000 + (Number.parseInt(identity.slice(0, 8), 16) % 30_000)
  const socket = new WebSocket(`ws://127.0.0.1:${port}/resident`)
  const clientNonce = randomUUID()
  const requestId = randomUUID()
  const events = new Array<ResidentEvent>()
  const feedSequences = new Array<number>()
  const commands = new Map<number, (outcome: ResidentCommandOutcome) => void>()
  let connectionId = ""
  let sessionId = ""
  let feedGeneration = ""
  let commandSequence = 0
  let closed = false
  const waiters = new Set<() => void>()
  const changed = () => {
    for (const waiter of waiters) waiter()
    waiters.clear()
  }
  const send = (message: Readonly<Record<string, unknown>>) => socket.send(JSON.stringify(message))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("resident command client startup timed out")), 10_000)
    socket.addEventListener("open", () =>
      send({ family: "rika-resident", identity, token, clientNonce, clientKind: "interactive" }),
    )
    socket.addEventListener("error", () => reject(new Error("resident command socket failed")))
    socket.addEventListener("message", (incoming) => {
      const message = JSON.parse(String(incoming.data)) as Record<string, unknown>
      if (message._tag === "accepted") {
        connectionId = String(message.connectionId)
        send({
          _tag: "operation",
          requestId,
          input: {
            _tag: "Interactive",
            prompt: [],
            threadId,
            ephemeral: false,
            clientWorkspace: context.workspace,
          },
        })
        return
      }
      if (message._tag === "interactive-started") {
        sessionId = String(message.sessionId)
        feedGeneration = String(message.feedGeneration)
        commandSequence += 1
        send({
          _tag: "interactive-command",
          connectionId,
          requestId,
          sessionId,
          feedGeneration,
          commandSequence,
          command: { _tag: "SelectThread", threadId, selectionEpoch: 1 },
        })
        return
      }
      if (message._tag === "interactive-feed-event" || message._tag === "interactive-feed-resync") {
        const sequence = Number(message.sequence)
        feedSequences.push(sequence)
        if (message._tag === "interactive-feed-event") events.push(message.event as ResidentEvent)
        else events.push(...(message.events as ReadonlyArray<ResidentEvent>))
        send({
          _tag: "interactive-feed-ack",
          connectionId,
          requestId,
          sessionId,
          feedGeneration,
          throughSequence: sequence,
        })
        changed()
        if (
          events.some(
            (event) =>
              event._tag === "SelectionLoaded" &&
              typeof event.thread === "object" &&
              event.thread !== null &&
              "id" in event.thread &&
              event.thread.id === threadId,
          )
        ) {
          clearTimeout(timer)
          resolve()
        }
        return
      }
      if (message._tag === "interactive-command-completed" || message._tag === "interactive-command-failed") {
        const sequence = Number(message.commandSequence)
        commands.get(sequence)?.({
          sequence,
          failed: message._tag === "interactive-command-failed",
          ...(message.error === undefined ? {} : { error: message.error }),
        })
        commands.delete(sequence)
      }
    })
    socket.addEventListener("close", () => {
      closed = true
      changed()
      reject(new Error("resident command socket closed during startup"))
    })
  })
  return {
    events,
    feedSequences,
    command: (command) =>
      new Promise((resolve, reject) => {
        if (closed) return reject(new Error("resident command socket is closed"))
        commandSequence += 1
        commands.set(commandSequence, resolve)
        send({
          _tag: "interactive-command",
          connectionId,
          requestId,
          sessionId,
          feedGeneration,
          commandSequence,
          command,
        })
      }),
    waitFor: async (predicate, timeoutMilliseconds = 30_000) => {
      const deadline = Date.now() + timeoutMilliseconds
      while (!predicate(events)) {
        if (closed) throw new Error("resident command socket closed while waiting for events")
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error(`resident event wait exceeded ${timeoutMilliseconds}ms`)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            () => {
              waiters.delete(wake)
              resolve()
            },
            Math.min(remaining, 100),
          )
          const wake = () => {
            clearTimeout(timer)
            resolve()
          }
          waiters.add(wake)
        })
      }
      return events
    },
    close: async () => {
      if (closed) return
      send({ _tag: "interactive-end", connectionId, requestId, sessionId, feedGeneration })
      socket.close()
      await new Promise<void>((resolve) => {
        if (closed) resolve()
        else socket.addEventListener("close", () => resolve(), { once: true })
      })
    },
  }
}

export const startResidentCommandClient = (context: Sandbox, threadId: string) =>
  Effect.tryPromise({ try: () => openClient(context, threadId), catch: clientFailure })
