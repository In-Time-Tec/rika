import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { CommandId, IdempotencyKey, RequestId, ThreadEventCursor, ThreadVersion } from "@rika/product/hosted-model"
import { protocolVersion, type HostedThreadSnapshot } from "@rika/product/client-protocol"
import type { InteractiveCommand } from "@rika/product/interactive-command"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { TurnId } from "@rika/product/turn-record"
import { HostedThreadApplication, type HostedThreadApplicationService } from "../../../../src/hosted/thread/application"
import { HostedProduct, type HostedProductService } from "../../../../src/hosted/product"
import { HostedThreadProtocol, layer as hostedThreadProtocolLayer } from "../../../../src/hosted/thread/protocol"
import { HostedToolPolicy } from "../../../../src/hosted/execution/tool-policy"
import { HostedWorkspace } from "../../../../src/hosted/environment/workspace"
import { testToolPolicy } from "../../execution/tool-policy.fixture"

import { actor, assignmentId, memoryStore, ownerId, presenceLayer, snapshot, threadId } from "./memory.fixture"

it.effect("admits authorization decisions without applying them in the socket session", () => {
  const store = memoryStore()
  const decisions: Array<Parameters<typeof testToolPolicy.recordDecision>[0]> = []
  const checkpoint = {
    version: ExecutionProjection.projectionVersion,
    cursor: "authorization-cursor",
    state: '{"operation":"shell","arguments":"bun test"}',
  }
  let currentSnapshot: HostedThreadSnapshot = {
    ...snapshot,
    pendingAuthorizations: [
      {
        threadId,
        turnId: TurnId.make("turn-authorization"),
        authorizationId: "authorization-1",
        operation: "rika.tool.processes.start",
        capability: "terminal.execute",
        input: '{"exact":"request"}',
        inputTruncated: false,
        checkpoint,
      },
    ],
  }
  const delivered: Array<InteractiveCommand> = []
  const product: HostedProductService = {
    ready: Effect.void,
    projects: () => Effect.succeed([]),
    createProject: () => Effect.die("unused"),
    activatePrincipal: () => Effect.void,
    createConnection: () => Effect.die("unused"),
    authorizeOwner: () => Effect.die("unused"),
    authorizeThread: () => Effect.succeed({ ownerId, actor }),
    threadExecutionContext: () =>
      Effect.succeed({
        workspaceId: "workspace-1",
        repository: {
          identity: "In-Time-Tec/rika",
          branch: "feature/thread-controls",
        },
        branch: "feature/thread-controls",
        executor: { assignmentId, kind: "orb", generation: "7" },
      }),
    registerRunner: () => Effect.die("unused"),
    setRemoteThreadCreation: () => Effect.die("unused"),
    pollRunner: () => Effect.die("unused"),
    admitRun: () => Effect.die("unused"),
    admitAuthorizedRun: () => Effect.die("unused"),
    cancelRunAdmission: () => Effect.die("unused"),
    cancelAuthorizedRunAdmission: () => Effect.die("unused"),
  }
  const operations: HostedThreadApplicationService = {
    threads: () => Effect.die("unused"),
    preview: () => Effect.die("unused"),
    thread: () => Effect.succeed(currentSnapshot.view.thread),
    interactive: (input, persist) =>
      Effect.suspend(() => {
        delivered.push(input.command)
        currentSnapshot = { ...currentSnapshot, pendingAuthorizations: [] }
        return persist({ events: [], snapshot: currentSnapshot })
      }),
    snapshot: () => Effect.succeed(currentSnapshot),
    projectionCommitted: () => Effect.die("unused"),
  }

  const dependencies = Layer.mergeAll(
    Layer.succeed(HostedProduct, product),
    Layer.succeed(HostedThreadApplication, operations),
    Layer.succeed(
      HostedWorkspace,
      HostedWorkspace.of({
        execute: () => Effect.die("unused"),
        pause: () => Effect.void,
        resume: () => Effect.void,
        portal: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(ThreadProtocolStore, store),
    presenceLayer,
    Layer.succeed(HostedToolPolicy, {
      ...testToolPolicy,
      recordDecision: (input) => Effect.sync(() => void decisions.push(input)),
    }),
    BunCrypto.layer,
  )
  return Effect.scoped(
    Effect.gen(function* () {
      const protocol = Context.get(
        yield* Layer.build(hostedThreadProtocolLayer.pipe(Layer.provide(dependencies))),
        HostedThreadProtocol,
      )
      const session = yield* protocol.connect("ticket", "/api/v1/threads/socket")
      const attached = yield* session.receive({
        protocolVersion,
        requestId: RequestId.make("attach-authorization"),
        command: {
          _tag: "AttachThread",
          threadId,
          afterCursor: ThreadEventCursor.make("0"),
        },
      })
      expect(attached).toMatchObject([
        {
          payload: {
            _tag: "ThreadAttached",
            checkpoint: { snapshot: currentSnapshot },
            events: [],
            participants: [],
          },
        },
      ])

      const approve = {
        protocolVersion,
        requestId: RequestId.make("approve-request"),
        command: {
          _tag: "Approve" as const,
          threadId,
          commandId: CommandId.make("approve-command"),
          idempotencyKey: IdempotencyKey.make("approve-key"),
          expectedThreadVersion: ThreadVersion.make("0"),
          turnId: TurnId.make("turn-authorization"),
          authorizationId: "authorization-1",
          checkpoint,
        },
      }
      expect(yield* session.receive(approve)).toMatchObject([
        { payload: { _tag: "CommandAdmitted", threadVersion: "1" } },
      ])
      expect(yield* session.receive(approve)).toMatchObject([
        { payload: { _tag: "CommandAdmitted", threadVersion: "1" } },
      ])
      expect(delivered).toEqual([])
      expect(store.command("approve-command")?.result).toBeUndefined()
      expect(decisions).toEqual([])
      const repaired = yield* protocol.connect("ticket-repaired", "/api/v1/threads/socket")
      expect(
        yield* repaired.receive({
          protocolVersion,
          requestId: RequestId.make("attach-repaired"),
          command: {
            _tag: "AttachThread",
            threadId,
            afterCursor: ThreadEventCursor.make("0"),
          },
        }),
      ).toMatchObject([
        {
          payload: {
            _tag: "ThreadAttached",
            threadVersion: "1",
            cursor: "0",
            baseCursor: "0",
            checkpoint: { threadVersion: "0", cursor: "0", snapshot: currentSnapshot },
            events: [],
          },
        },
      ])

      expect(
        yield* session.receive({
          protocolVersion,
          requestId: RequestId.make("stale-request"),
          command: {
            ...approve.command,
            commandId: CommandId.make("stale-command"),
            idempotencyKey: IdempotencyKey.make("stale-key"),
            expectedThreadVersion: ThreadVersion.make("1"),
          },
        }),
      ).toMatchObject([
        {
          payload: {
            _tag: "CommandAdmitted",
            threadVersion: "2",
          },
        },
      ])
      expect(delivered).toHaveLength(0)

      const denialCheckpoint = { ...checkpoint, cursor: "denial-cursor" }
      currentSnapshot = {
        ...currentSnapshot,
        pendingAuthorizations: [
          {
            threadId,
            turnId: TurnId.make("turn-denial"),
            authorizationId: "authorization-2",
            operation: "write-file",
            capability: "filesystem",
            input: '{"path":"README.md"}',
            inputTruncated: false,
            checkpoint: denialCheckpoint,
          },
        ],
      }
      expect(
        yield* session.receive({
          protocolVersion,
          requestId: RequestId.make("deny-request"),
          command: {
            _tag: "Deny",
            threadId,
            commandId: CommandId.make("deny-command"),
            idempotencyKey: IdempotencyKey.make("deny-key"),
            expectedThreadVersion: ThreadVersion.make("2"),
            turnId: TurnId.make("turn-denial"),
            authorizationId: "authorization-2",
            checkpoint: denialCheckpoint,
          },
        }),
      ).toMatchObject([{ payload: { _tag: "CommandAdmitted", threadVersion: "3" } }])
      expect(delivered).toHaveLength(0)
      expect(store.command("deny-command")?.result).toBeUndefined()
    }),
  )
})
