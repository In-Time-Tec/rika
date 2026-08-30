import { Clock, Effect, Queue, Ref } from "effect"
import type { ForegroundRunnerSnapshot } from "./foreground-contract"
import { ForegroundRunnerError } from "./foreground-contract"
import type { AccessWire, ApiMessage as IncomingMessage, Fence, WelcomeWire } from "../../protocol/messages"

export interface LocalSession {
  readonly fence: Fence
  readonly leaseEpoch: number
  readonly sessionToken: string
  readonly leaseExpiresAt: number
  readonly heartbeatIntervalMillis: number
  readonly cursor: { readonly sequence: number; readonly value: string }
}

const failure = (message: string) => ForegroundRunnerError.make({ message })

const sameFence = (left: Fence, right: Fence) =>
  left.target === right.target &&
  left.assignmentId === right.assignmentId &&
  left.assignmentGeneration === right.assignmentGeneration &&
  left.instanceId === right.instanceId &&
  left.executorId === right.executorId &&
  left.processIncarnation === right.processIncarnation

const sameAccess = (left: AccessWire, right: AccessWire) =>
  left.version === right.version &&
  left.leaseEpoch === right.leaseEpoch &&
  left.sessionToken === right.sessionToken &&
  sameFence(left.fence, right.fence)

const runnerUrl = (
  value: string,
  expiresAt: number | undefined,
  trustedOrigin: string | undefined,
): Effect.Effect<string, ForegroundRunnerError> =>
  Effect.gen(function* () {
    if (expiresAt !== undefined && expiresAt <= (yield* Clock.currentTimeMillis))
      return yield* failure("Runner admission has expired")
    return yield* Effect.try({
      try: () => {
        const url = new URL(value)
        if (
          url.protocol !== "wss:" ||
          url.pathname !== "/api/v1/runners" ||
          url.username.length > 0 ||
          url.password.length > 0 ||
          url.search.length > 0 ||
          url.hash.length > 0
        )
          throw new Error("Runner URL is not a pinned wss:// endpoint")
        if (trustedOrigin !== undefined) {
          const origin = new URL(trustedOrigin)
          if (origin.protocol !== "https:" || `wss://${origin.host}` !== url.origin)
            throw new Error("Runner URL is outside the trusted hosted origin")
        }
        return url.toString()
      },
      catch: () => failure("Runner URL must be a pinned wss:// endpoint"),
    })
  })

const access = (session: LocalSession): AccessWire => ({
  version: 1,
  fence: session.fence,
  leaseEpoch: session.leaseEpoch,
  sessionToken: session.sessionToken,
})

const sessionFromWelcome = (
  welcome: WelcomeWire,
  processIncarnation: string,
): Effect.Effect<LocalSession, ForegroundRunnerError> =>
  Effect.gen(function* () {
    if (welcome.fence.target !== "runner") return yield* failure("Runner welcome has a non-Runner fence")
    if (welcome.fence.processIncarnation !== processIncarnation)
      return yield* failure("Runner welcome has a different process incarnation")
    return {
      fence: welcome.fence,
      leaseEpoch: welcome.leaseEpoch,
      sessionToken: welcome.sessionToken,
      leaseExpiresAt: welcome.leaseExpiresAt,
      heartbeatIntervalMillis: welcome.heartbeatIntervalMillis,
      cursor: welcome.cursor,
    }
  })

const waitForWelcome = (
  incoming: Queue.Queue<IncomingMessage>,
  processIncarnation: string,
): Effect.Effect<LocalSession, ForegroundRunnerError> =>
  Effect.gen(function* () {
    const message = yield* Queue.take(incoming)
    if (message._tag === "Fenced") return yield* failure(message.message)
    if (message._tag === "ExecutorWelcome") return yield* sessionFromWelcome(message.welcome, processIncarnation)
    return yield* waitForWelcome(incoming, processIncarnation)
  })

const sessionFromReconnect = (
  welcome: Extract<IncomingMessage, { readonly _tag: "ExecutorReconnected" }>["welcome"],
  previous: LocalSession,
  processIncarnation: string,
): Effect.Effect<LocalSession, ForegroundRunnerError> =>
  Effect.gen(function* () {
    if (!sameFence(welcome.fence, previous.fence) || welcome.fence.processIncarnation !== processIncarnation)
      return yield* failure("Runner reconnect has a different fence")
    return {
      ...previous,
      leaseEpoch: welcome.leaseEpoch,
      leaseExpiresAt: welcome.leaseExpiresAt,
      heartbeatIntervalMillis: welcome.heartbeatIntervalMillis,
      cursor: welcome.cursor,
    }
  })

const waitForReconnect = (
  incoming: Queue.Queue<IncomingMessage>,
  previous: LocalSession,
  processIncarnation: string,
): Effect.Effect<LocalSession, ForegroundRunnerError> =>
  Effect.gen(function* () {
    const message = yield* Queue.take(incoming)
    if (message._tag === "Fenced") return yield* failure(message.message)
    if (message._tag === "ExecutorReconnected")
      return yield* sessionFromReconnect(message.welcome, previous, processIncarnation)
    return yield* waitForReconnect(incoming, previous, processIncarnation)
  })

const applyLeaseReceipt = (
  message: Extract<IncomingMessage, { readonly _tag: "LeaseReceipt" }>,
  session: Ref.Ref<LocalSession | undefined>,
  persist: () => Effect.Effect<void, ForegroundRunnerError>,
) =>
  Effect.gen(function* () {
    const current = yield* Ref.get(session)
    if (current === undefined) return yield* failure("Runner session is unavailable")
    if (!sameFence(current.fence, message.receipt.fence) || message.receipt.leaseEpoch !== current.leaseEpoch)
      return yield* failure("Runner receipt has a stale session")
    if (message.receipt.cursor.sequence < current.cursor.sequence)
      return yield* failure("Runner receipt moved the cursor backwards")
    if (
      message.receipt.cursor.sequence === current.cursor.sequence &&
      message.receipt.cursor.value !== current.cursor.value
    )
      return yield* failure("Runner receipt conflicts at the current cursor")
    yield* Ref.set(session, {
      ...current,
      leaseExpiresAt: message.receipt.leaseExpiresAt,
      cursor: message.receipt.cursor,
    })
    yield* persist()
  })

const initialSessionFor = (resume: ForegroundRunnerSnapshot | undefined): LocalSession | undefined =>
  resume === undefined
    ? undefined
    : {
        fence: resume.access.fence,
        leaseEpoch: resume.access.leaseEpoch,
        sessionToken: resume.access.sessionToken,
        leaseExpiresAt: resume.leaseExpiresAt,
        heartbeatIntervalMillis: resume.heartbeatIntervalMillis,
        cursor: resume.cursor,
      }

export const ForegroundSession = {
  access,
  applyLeaseReceipt,
  failure,
  initialSessionFor,
  runnerUrl,
  sameAccess,
  waitForReconnect,
  waitForWelcome,
}
