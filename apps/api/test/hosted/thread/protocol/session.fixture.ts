import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { Effect, Layer } from "effect"
import type { AuthorizationAction } from "@rika/product/hosted-authorization"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { HostedThreadApplication, type HostedThreadApplicationService } from "../../../../src/hosted/thread/application"
import {
  HostedProduct,
  HostedProductError,
  type HostedProductService,
  type OwnerSelection,
} from "../../../../src/hosted/product"
import { makeThreadProtocolNotifications } from "../../../../src/hosted/thread/notifications"
import { HostedWorkspace, HostedWorkspaceError } from "../../../../src/hosted/environment/workspace"

import { actor, assignmentId, memoryStore, ownerId, presenceLayer, snapshot, threadId } from "./memory.fixture"
export const makeSessionFixture = () => {
  const store = memoryStore()
  const notifications = makeThreadProtocolNotifications()
  let selectedOwner: OwnerSelection | undefined
  let archiveThreadId: string | undefined
  const applied: Array<string> = []
  const admittedRuns: Array<Parameters<HostedProductService["admitRun"]>[0]> = []
  const authorizedActions: Array<AuthorizationAction> = []
  const workspaceRequests: Array<string> = []
  const workspaceLifecycle: Array<"paused" | "resumed"> = []
  let pauseAttempts = 0
  const product: HostedProductService = {
    ready: Effect.void,
    projects: () => Effect.succeed([]),
    createProject: () => Effect.die("unused"),
    activatePrincipal: () => Effect.void,
    authorizeOwner: () => Effect.die("unused"),
    authorizeThread: (_principal, _threadId, action) =>
      Effect.sync(() => {
        authorizedActions.push(action)
        return { ownerId, actor }
      }),
    threadExecutionContext: () =>
      Effect.succeed({
        workspaceId: "workspace-1",
        repository: { identity: "repository-1", branch: "main" },
        branch: "main",
        executor: { assignmentId, kind: "runner", generation: "1" },
      }),
    registerRunner: () => Effect.die("unused"),
    setRemoteThreadCreation: () => Effect.die("unused"),
    pollRunner: () => Effect.die("unused"),
    createConnection: (input) =>
      input.threadId === "create-failed"
        ? Effect.fail(
            HostedProductError.make({
              kind: "unavailable",
              message: "creation unavailable",
            }),
          )
        : Effect.sync(() => {
            selectedOwner = input.owner
            archiveThreadId = input.archiveThreadId
            return { threadId }
          }),
    admitRun: (input) =>
      Effect.sync(() => {
        if (input.operationKey === "submit-cancelled")
          return {
            _tag: "Cancelled" as const,
            commandId: input.operationKey,
          }
        if (!admittedRuns.some((admitted) => admitted.operationKey === input.operationKey)) admittedRuns.push(input)
        return {
          _tag: "Admitted" as const,
          commandId: input.operationKey,
          turnId: `turn-${input.operationKey}`,
          status: "queued" as const,
        }
      }),
    admitAuthorizedRun: () => Effect.die("unused"),
    cancelRunAdmission: (input) =>
      input.targetCommandId === "submit-cancelled" ? Effect.succeed({}) : Effect.die("unused"),
    cancelAuthorizedRunAdmission: () => Effect.die("unused"),
  }
  const operations: HostedThreadApplicationService = {
    threads: () => Effect.die("unused"),
    preview: () => Effect.die("unused"),
    thread: () => Effect.succeed(snapshot.view.thread),
    snapshot: () => Effect.succeed(snapshot),
    projectionCommitted: () => Effect.die("unused"),
    interactive: (input, persist) => {
      applied.push(input.commandId)
      return persist({
        events: [{ _tag: "ExecutionControlled", action: "cancelled" as const }],
        snapshot,
      })
    },
  }
  const dependencies = Layer.mergeAll(
    Layer.succeed(HostedProduct, product),
    Layer.succeed(HostedThreadApplication, operations),
    Layer.succeed(
      HostedWorkspace,
      HostedWorkspace.of({
        execute: (_threadId, request) =>
          Effect.sync(() => {
            workspaceRequests.push(request._tag)
            if (request._tag === "WorkspaceFileInspect")
              return {
                _tag: "WorkspaceFileContent" as const,
                requestId: request.requestId,
                path: request.path,
                sizeBytes: 2,
                contentBase64: "e30=",
              }
            return {
              _tag:
                request._tag === "RepositoryServiceEnsure"
                  ? ("RepositoryServiceRunning" as const)
                  : ("RepositoryServiceStopped" as const),
              requestId: request.requestId,
              serviceId: request._tag === "RepositoryServiceEnsure" ? request.service.serviceId : request.serviceId,
            }
          }),
        pause: () =>
          Effect.suspend(() => {
            pauseAttempts += 1
            if (pauseAttempts === 1)
              return Effect.fail(
                HostedWorkspaceError.make({
                  kind: "unavailable",
                  message: "pause interrupted",
                }),
              )
            return Effect.sync(() => void workspaceLifecycle.push("paused"))
          }),
        resume: () => Effect.sync(() => void workspaceLifecycle.push("resumed")),
        portal: (_threadId, port) => Effect.succeed(`https://${port}-orb.e2b.app`),
      }),
    ),
    Layer.succeed(ThreadProtocolStore, store),
    presenceLayer,
    BunCrypto.layer,
  )
  return {
    store,
    notifications,
    applied,
    admittedRuns,
    authorizedActions,
    workspaceRequests,
    workspaceLifecycle,
    dependencies,
    selectedOwner: () => selectedOwner,
    archiveThreadId: () => archiveThreadId,
  }
}
