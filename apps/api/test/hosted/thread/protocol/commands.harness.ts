import type { HostedThreadSnapshot, ServerFrame } from "@rika/product/client-protocol"
import { CommandId, IdempotencyKey, ThreadId, ThreadVersion } from "@rika/product/hosted-model"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { TurnId } from "@rika/product/turn-record"
import { Effect } from "effect"
import type { HostedProductService } from "../../../../src/hosted/product"
import { actor, later, now, ownerId, threadId } from "./values.harness"

export const command = (id: string, expectedThreadVersion: string) => ({
  ownerId,
  threadId,
  commandId: CommandId.make(id),
  turnId: TurnId.make(`turn-${id}`),
  idempotencyKey: IdempotencyKey.make(`${id}-key`),
  expectedThreadVersion: ThreadVersion.make(expectedThreadVersion),
  actor,
  command: { _tag: "Cancel" },
  admittedAt: now,
})

export const completeMockPrompt = (
  store: ThreadProtocolStore["Service"],
  input: Parameters<HostedProductService["admitAuthorizedRun"]>[0],
  status: "accepted" | "queued",
  completedSnapshot?: HostedThreadSnapshot,
) => {
  if (input.claimToken === undefined) return Effect.die("Worker prompt admission is missing its command claim")
  const completion: Parameters<ThreadProtocolStore["Service"]["completeCommand"]>[0] = {
    ownerId: input.authority.ownerId,
    threadId: ThreadId.make(input.threadId),
    commandId: CommandId.make(input.operationKey),
    claimToken: input.claimToken,
    result: { _tag: "PromptAdmitted", status },
    events: [
      {
        _tag: "SubmissionAdmitted",
        threadId: ProductThreadId.make(input.threadId),
        turnId: TurnId.make(input.turnId),
        status: status === "accepted" ? "active" : "queued",
        submissionId: input.submissionId ?? input.operationKey,
      },
    ],
    completedAt: later,
  }
  if (completedSnapshot !== undefined) Object.assign(completion, { snapshot: completedSnapshot })
  return store
    .completeCommand(completion)
    .pipe(
      Effect.orDie,
      Effect.as({ _tag: "Admitted" as const, commandId: input.operationKey, turnId: input.turnId, status }),
    )
}

export const attachedPayload = (frame: ServerFrame | undefined) => {
  const payload = frame?.payload
  if (payload?._tag !== "ThreadAttached") throw new Error("expected ThreadAttached")
  return payload
}
