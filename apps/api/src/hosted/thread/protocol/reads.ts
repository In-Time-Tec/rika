import type { ClientMessage, ServerFrame } from "@rika/product/client-protocol"
import { ThreadId } from "@rika/product/thread-record"
import { Effect } from "effect"
import type { HostedThreadApplicationService } from "../application"
import type { ThreadAuthority } from "../../product"
import type { HostedWorkspace } from "../../environment/workspace"
import { frame, HostedThreadProtocolError, unavailable } from "../protocol-contract"

type ReadMessage = ClientMessage & {
  readonly command: Extract<ClientMessage["command"], { readonly _tag: "ReadThreadHistory" | "InspectWorkspaceFile" }>
}

export const threadReadCommands = ({
  operations,
  workspace,
}: {
  readonly operations: HostedThreadApplicationService
  readonly workspace: HostedWorkspace["Service"]
}) =>
  Effect.fn("HostedThreadProtocol.read")(function* (
    message: ReadMessage,
    authority: ThreadAuthority,
  ): Effect.fn.Return<ReadonlyArray<ServerFrame>, HostedThreadProtocolError> {
    const command = message.command
    if (command._tag === "ReadThreadHistory") {
      const view = yield* operations
        .history(authority.ownerId, ThreadId.make(command.threadId), command.before)
        .pipe(Effect.mapError((error) => unavailable(error.message)))
      return [
        frame({
          _tag: "ThreadHistory",
          requestId: message.requestId,
          threadId: command.threadId,
          before: command.before,
          view,
        }),
      ]
    }
    const inspection = yield* workspace
      .execute(command.threadId, {
        _tag: "WorkspaceFileInspect",
        requestId: String(message.requestId),
        path: command.path,
        maximumBytes: command.maximumBytes,
      })
      .pipe(
        Effect.mapError((error) =>
          HostedThreadProtocolError.make({
            kind: error.kind === "unsupported" ? "invalid" : "unavailable",
            message: error.message,
          }),
        ),
      )
    if (inspection._tag !== "WorkspaceFileContent" && inspection._tag !== "WorkspaceFileRejected")
      return yield* unavailable("Executor returned an invalid file inspection result")
    return [
      frame({ _tag: "WorkspaceFileInspected", requestId: message.requestId, threadId: command.threadId, inspection }),
    ]
  })
