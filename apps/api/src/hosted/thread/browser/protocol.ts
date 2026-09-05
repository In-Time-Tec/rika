import { Clock, DateTime, Effect } from "effect"
import type { HostedProduct } from "../../product"
import {
  protocolConnectionState,
  type ProtocolConnectionDependencies,
  type ProtocolConnectionState,
} from "../protocol-connection"
import {
  type BrowserReadPrincipal,
  type HostedThreadConnection,
  type HostedThreadProtocolService,
  HostedThreadProtocolError,
  frame,
  unavailable,
  validateBrowserRead,
} from "../protocol-contract"

const browserConnection = (input: {
  readonly principal: BrowserReadPrincipal
  readonly product: HostedProduct["Service"]
  readonly connection: ProtocolConnectionState
}): HostedThreadConnection => {
  const { principal, product, connection } = input
  // Keep final delivery bound to the original ACL even after Detach. Navigation
  // opens a fresh socket, so queued frames cannot borrow a different Thread's ACL.
  let boundThreadId: string | undefined
  const validate = Effect.suspend(() => validateBrowserRead({ principal, product, threadId: boundThreadId }))
  const authorized = validate.pipe(
    Effect.flatMap((valid) => (valid ? Effect.void : Effect.fail(unavailable("Browser review access expired")))),
  )
  return {
    validate,
    receive: (message) =>
      Effect.gen(function* () {
        yield* authorized
        const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
        if (message.command._tag === "AttachThread") {
          if (boundThreadId !== undefined && boundThreadId !== message.command.threadId)
            return yield* HostedThreadProtocolError.make({
              kind: "forbidden",
              message: "Open a new browser connection to review another Thread.",
            })
          const frames = yield* connection.attach(message.command, message.requestId, now)
          boundThreadId = message.command.threadId
          return frames
        }
        if (message.command._tag === "Detach") return yield* connection.detach(now)
        return [
          frame({
            _tag: "CommandRejected",
            requestId: message.requestId,
            reason: "forbidden",
            message: "Browser review is read-only. Use an authenticated Rika CLI to control work.",
            details: {},
          }),
        ]
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed([
            frame({
              _tag: "CommandRejected",
              requestId: message.requestId,
              reason: error.kind,
              message: error.message,
              details: {},
            }),
          ]),
        ),
      ),
    outbound: connection.outbound(connection.ready, connection.drain).pipe(Effect.tap(() => authorized)),
    detach: connection.close,
  }
}

export const browserConnections = (
  dependencies: Omit<ProtocolConnectionDependencies, "principal">,
): HostedThreadProtocolService["connectBrowser"] =>
  Effect.fn("HostedThreadProtocol.connectBrowser")(function* (principal) {
    if (!(yield* principal.validate)) return yield* unavailable("Browser session expired")
    return browserConnection({
      principal,
      product: dependencies.product,
      connection: protocolConnectionState({ ...dependencies, principal }),
    })
  })
