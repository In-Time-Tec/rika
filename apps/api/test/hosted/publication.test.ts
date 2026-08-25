import { expect, it } from "@effect/vitest"
import {
  AssignmentLeaseEpoch,
  BetterAuthUserId,
  ClientId,
  DeviceId,
  FencingGeneration,
  OwnerId,
  type ActorAttribution,
} from "@rika/product/hosted-model"
import type { BranchPushOutcome } from "@rika/remote-execution/protocol"
import { Context, Effect, Layer, Stream } from "effect"
import type { Gateway } from "../../src/executor/gateway"
import { Executor as ExecutorService } from "../../src/executor/service"
import { HostedProduct } from "../../src/hosted/product"
import { HostedPublication, layer as publicationLayer, type PublishInput } from "../../src/hosted/publication"
import {
  HostedRepositories,
  type ApprovedPublication,
  type HostedRepositoriesService,
} from "../../src/hosted/repositories"

const actor: ActorAttribution = {
  _tag: "PersonalActor",
  owner: { _tag: "PersonalOwner", userId: BetterAuthUserId.make("user-1") },
  userId: BetterAuthUserId.make("user-1"),
  clientId: ClientId.make("client-1"),
  deviceId: DeviceId.make("device-1"),
}

const approved: ApprovedPublication = {
  id: "publication-1",
  ownerId: "owner-1",
  threadId: "thread-1",
  projectId: "project-1",
  repositoryId: "repository-1",
  assignmentId: "assignment-1",
  assignmentGeneration: FencingGeneration.make("1"),
  leaseEpoch: AssignmentLeaseEpoch.make("1"),
  workspaceId: "workspace-1",
  authorizationCheckpointId: "publication-1",
  authorizationDigest: `sha256:${"a".repeat(64)}`,
  sourceBranch: "rika/thread-1",
  sourceRef: "refs/heads/rika/thread-1",
  sourceCommitSha: "b".repeat(40),
  target: { ref: "main", commitSha: "c".repeat(40), protected: true },
  title: "Publish thread-1",
  body: "Approved publication",
  state: "approved",
  pushResult: null,
  pullRequestResult: null,
}

it.effect("pushes an approved ref, creates the pull request through API authority, and revokes the write token", () =>
  Effect.gen(function* () {
    const events: Array<unknown> = []
    const eventTags: Array<string> = []
    const repositories = {
      authorize: () => Effect.void,
      resolve: () => Effect.die("unused"),
      credential: () => Effect.die("unused"),
      revoke: () => Effect.void,
      inspectTarget: () => Effect.die("unused"),
      approvePublication: (input) => {
        eventTags.push("approved")
        events.push({ _tag: "approved", input })
        return Effect.succeed(approved)
      },
      recordPush: (publication, result, state) => {
        eventTags.push("push-result")
        events.push({ _tag: "push-result", result, state })
        return Effect.succeed({ ...publication, state, pushResult: result })
      },
      createPullRequest: (input) => {
        eventTags.push("pull-request")
        events.push({ _tag: "pull-request", input })
        return Effect.succeed({
          number: 7,
          url: "https://github.test/pr/7",
          commitSha: input.commitSha,
          targetRef: "main",
        })
      },
      recordPullRequest: (publication, result, succeeded) => {
        eventTags.push("pull-request-result")
        events.push({ _tag: "pull-request-result", result, succeeded })
        return Effect.succeed({
          ...publication,
          state: succeeded ? "completed" : "failed",
          pullRequestResult: result,
        })
      },
      revokePublicationCredential: (publicationId) =>
        Effect.sync(() => {
          eventTags.push("revoked")
          events.push({ _tag: "revoked", publicationId })
        }),
    } satisfies HostedRepositoriesService
    const product = HostedProduct.of({
      ready: Effect.die("unused"),
      projects: () => Effect.die("unused"),
      createProject: () => Effect.die("unused"),
      createConnection: () => Effect.die("unused"),
      registerRunner: () => Effect.die("unused"),
      setRemoteThreadCreation: () => Effect.die("unused"),
      pollRunner: () => Effect.die("unused"),
      admitAuthorizedRun: () => Effect.die("unused"),
      cancelRunAdmission: () => Effect.die("unused"),
      cancelAuthorizedRunAdmission: () => Effect.die("unused"),
      admitRun: () => Effect.die("unused"),
      authorizeThread: () => Effect.succeed({ ownerId: OwnerId.make("owner-1"), actor }),
      threadExecutionContext: () => Effect.die("unused"),
      activatePrincipal: () => Effect.die("unused"),
    })
    let pushOutcome: BranchPushOutcome = {
      _tag: "Succeeded",
      branch: approved.sourceBranch,
      ref: approved.sourceRef,
      commitSha: approved.sourceCommitSha,
    }
    const gateway: Gateway = {
      receive: () => Effect.void,
      disconnected: () => Effect.void,
      active: () => Effect.succeed(true),
      cancel: () => Effect.die("unused"),
      machine: () => Effect.die("unused"),
      execute: () => Effect.die("unused"),
      sendPty: () => Effect.die("unused"),
      ptyEvents: () => Stream.empty,
      retryPreparation: () => Effect.die("unused"),
      workspace: () => Effect.die("unused"),
      quiesce: () => Effect.die("unused"),
      pushBranch: (input) => {
        eventTags.push("push")
        events.push({ _tag: "push", input })
        return Effect.succeed(pushOutcome)
      },
    }
    const executor = ExecutorService.of({
      controller: {
        provision: () => Effect.die("unused"),
        replace: () => Effect.die("unused"),
        resume: () => Effect.die("unused"),
        pause: () => Effect.die("unused"),
        kill: () => Effect.die("unused"),
        portal: () => Effect.die("unused"),
        hello: () => Effect.die("unused"),
        reconnect: () => Effect.die("unused"),
        validateAccess: () => Effect.die("unused"),
        heartbeat: () => Effect.die("unused"),
        checkpoint: () => Effect.die("unused"),
        credential: () => Effect.die("unused"),
        revokeCredential: () => Effect.die("unused"),
        workspace: () => Effect.die("unused"),
        ready: () => Effect.die("unused"),
        loadSetupCache: () => Effect.die("unused"),
        storeSetupCache: () => Effect.die("unused"),
        activatePhase: () => Effect.die("unused"),
        cleanupOrphans: Effect.die("unused"),
      },
      gateway,
      runnerGateway: {
        receive: () => Effect.die("unused"),
        disconnected: () => Effect.die("unused"),
        active: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
        machine: () => Effect.die("unused"),
        execute: () => Effect.die("unused"),
      },
      admitRunner: () => Effect.die("unused"),
      admitRun: () => Effect.die("unused"),
      run: () => Effect.die("unused"),
      ready: Effect.die("unused"),
      pause: () => Effect.die("unused"),
      resume: () => Effect.die("unused"),
      replace: () => Effect.die("unused"),
    })
    const context = yield* Layer.build(
      publicationLayer({ product, executor }).pipe(
        Layer.provide(Layer.succeed(HostedRepositories, HostedRepositories.of(repositories))),
      ),
    )
    const publication = Context.get(context, HostedPublication)
    const input: PublishInput = {
      principal: { userId: "user-1", deviceId: "device-1", clientId: "client-1" },
      threadId: approved.threadId,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      commitSha: approved.sourceCommitSha,
      title: approved.title,
      body: approved.body,
    }
    const result = yield* publication.publish(input)
    expect(result.state).toBe("completed")
    expect(eventTags).toEqual(["approved", "push", "push-result", "pull-request", "pull-request-result", "revoked"])
    expect(events[1]).toMatchObject({
      _tag: "push",
      input: {
        publicationId: approved.id,
        assignmentId: approved.assignmentId,
        branch: approved.sourceBranch,
        ref: approved.sourceRef,
        commitSha: approved.sourceCommitSha,
      },
    })
    expect(events[3]).toMatchObject({
      _tag: "pull-request",
      input: { ownerId: approved.ownerId, repositoryId: approved.repositoryId, sourceBranch: approved.sourceBranch },
    })
    events.length = 0
    eventTags.length = 0
    pushOutcome = { _tag: "Failed", kind: "git", message: "push result is ambiguous" }
    expect((yield* publication.publish(input)).state).toBe("unknown")
    expect(events).toContainEqual({
      _tag: "push-result",
      result: { outcome: "unknown", authority: "assignment-workspace", reason: "git" },
      state: "unknown",
    })
    expect(eventTags.includes("pull-request")).toBe(false)
  }),
)
