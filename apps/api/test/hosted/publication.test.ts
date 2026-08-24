import { expect, it } from "@effect/vitest"
import type { BranchPushOutcome } from "@rika/remote-execution/protocol"
import { Context, Effect, Layer } from "effect"
import type { Runtime as Executor } from "../../src/executor/service"
import type { HostedProductService } from "../../src/hosted/product"
import { HostedPublication, layer as publicationLayer } from "../../src/hosted/publication"
import {
  HostedRepositories,
  type ApprovedPublication,
  type HostedRepositoriesService,
} from "../../src/hosted/repositories"

const actor = {
  _tag: "PersonalActor",
  owner: { _tag: "PersonalOwner", userId: "user-1" },
  userId: "user-1",
  clientId: "client-1",
  deviceId: "device-1",
} as const

const approved: ApprovedPublication = {
  id: "publication-1",
  ownerId: "owner-1",
  threadId: "thread-1",
  projectId: "project-1",
  repositoryId: "repository-1",
  assignmentId: "assignment-1",
  assignmentGeneration: 1,
  leaseEpoch: 1,
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
    const repositories = {
      authorize: () => Effect.void,
      resolve: () => Effect.die("unused"),
      credential: () => Effect.die("unused"),
      revoke: () => Effect.void,
      inspectTarget: () => Effect.die("unused"),
      approvePublication: (input) => {
        events.push({ _tag: "approved", input })
        return Effect.succeed(approved)
      },
      recordPush: (publication, result, state) => {
        events.push({ _tag: "push-result", result, state })
        return Effect.succeed({ ...publication, state, pushResult: result })
      },
      createPullRequest: (input) => {
        events.push({ _tag: "pull-request", input })
        return Effect.succeed({
          number: 7,
          url: "https://github.test/pr/7",
          commitSha: input.commitSha,
          targetRef: "main",
        })
      },
      recordPullRequest: (publication, result, succeeded) => {
        events.push({ _tag: "pull-request-result", result, succeeded })
        return Effect.succeed({
          ...publication,
          state: succeeded ? "completed" : "failed",
          pullRequestResult: result,
        })
      },
      revokePublicationCredential: (publicationId) =>
        Effect.sync(() => events.push({ _tag: "revoked", publicationId })).pipe(Effect.asVoid),
    } satisfies HostedRepositoriesService
    const product = {
      authorizeThread: () => Effect.succeed({ ownerId: "owner-1", actor }),
    } as unknown as HostedProductService
    let pushOutcome: BranchPushOutcome = {
      _tag: "Succeeded" as const,
      branch: approved.sourceBranch,
      ref: approved.sourceRef,
      commitSha: approved.sourceCommitSha,
    }
    const executor = {
      gateway: {
        pushBranch: (input: unknown) => {
          events.push({ _tag: "push", input })
          return Effect.succeed(pushOutcome)
        },
      },
    } as unknown as Executor
    const context = yield* Layer.build(
      publicationLayer({ product, executor }).pipe(
        Layer.provide(Layer.succeed(HostedRepositories, HostedRepositories.of(repositories))),
      ),
    )
    const publication = Context.get(context, HostedPublication)
    const input = {
      principal: { userId: "user-1", deviceId: "device-1", clientId: "client-1" },
      threadId: approved.threadId,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      commitSha: approved.sourceCommitSha,
      title: approved.title,
      body: approved.body,
    } as const
    const result = yield* publication.publish(input)
    expect(result.state).toBe("completed")
    expect(events.map((event) => (event as { _tag: string })._tag)).toEqual([
      "approved",
      "push",
      "push-result",
      "pull-request",
      "pull-request-result",
      "revoked",
    ])
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
    pushOutcome = { _tag: "Failed", kind: "git", message: "push result is ambiguous" }
    expect((yield* publication.publish(input)).state).toBe("unknown")
    expect(events).toContainEqual({
      _tag: "push-result",
      result: { outcome: "unknown", authority: "assignment-workspace", reason: "git" },
      state: "unknown",
    })
    expect(events.some((event) => (event as { _tag: string })._tag === "pull-request")).toBe(false)
  }),
)
