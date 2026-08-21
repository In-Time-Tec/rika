import { Context, Effect, Layer, Schema } from "effect"
import type { AuthenticatedPrincipal, HostedProductService } from "./hosted-product"
import type { Runtime as Executor } from "./executor"
import { HostedRepositories, type ApprovedPublication } from "./hosted-repositories"

export class HostedPublicationError extends Schema.TaggedError<HostedPublicationError>()("HostedPublicationError", {
  kind: Schema.Literals(["forbidden", "invalid", "missing", "conflict", "unavailable"]),
  message: Schema.String,
}) {}

export interface PublishInput {
  readonly principal: AuthenticatedPrincipal
  readonly threadId: string
  readonly idempotencyKey: string
  readonly commitSha: string
  readonly targetRef?: string
  readonly title: string
  readonly body: string
}

export interface HostedPublicationService {
  readonly publish: (input: PublishInput) => Effect.Effect<ApprovedPublication, HostedPublicationError>
}

export class HostedPublication extends Context.Service<HostedPublication, HostedPublicationService>()(
  "@rika/api/hosted-publication/HostedPublication",
) {}

const rejected = (kind: HostedPublicationError["kind"], message: string) =>
  HostedPublicationError.make({ kind, message })

export const layer = (options: { readonly product: HostedProductService; readonly executor: Executor }) =>
  Layer.effect(
    HostedPublication,
    Effect.gen(function* () {
      const repositories = yield* HostedRepositories

      const pullRequest = Effect.fn("HostedPublication.pullRequest")(function* (approved: ApprovedPublication) {
        const receipt = yield* Effect.result(
          repositories.createPullRequest({
            ownerId: approved.ownerId,
            projectId: approved.projectId,
            repositoryId: approved.repositoryId,
            sourceBranch: approved.sourceBranch,
            commitSha: approved.sourceCommitSha,
            target: approved.target,
            title: approved.title,
            body: approved.body,
          }),
        )
        if (receipt._tag === "Failure")
          return yield* repositories.recordPullRequest(
            approved,
            { outcome: "failed", authority: "github-api", reason: receipt.failure.reason },
            false,
          )
        return yield* repositories.recordPullRequest(
          approved,
          {
            outcome: "succeeded",
            authority: "github-api",
            number: receipt.success.number,
            url: receipt.success.url,
            commitSha: receipt.success.commitSha,
            targetRef: receipt.success.targetRef,
          },
          true,
        )
      })

      const publish: HostedPublicationService["publish"] = Effect.fn("HostedPublication.publish")(function* (input) {
        const authority = yield* options.product
          .authorizeThread(input.principal, input.threadId, "thread:operate")
          .pipe(
            Effect.mapError((error) => {
              if (error.kind === "not-found") return rejected("missing", error.message)
              if (error.kind === "forbidden") return rejected("forbidden", error.message)
              return rejected("unavailable", "Publication authorization is unavailable")
            }),
          )
        let approved = yield* repositories
          .approvePublication({
            ownerId: authority.ownerId,
            threadId: input.threadId,
            actor: authority.actor,
            idempotencyKey: input.idempotencyKey,
            commitSha: input.commitSha,
            ...(input.targetRef === undefined ? {} : { targetRef: input.targetRef }),
            title: input.title,
            body: input.body,
          })
          .pipe(
            Effect.mapError((error) => {
              if (error.reason === "authorization") return rejected("forbidden", error.message)
              if (error.reason === "configuration" || error.reason === "identity")
                return rejected("invalid", error.message)
              if (error.reason === "stale-fence") return rejected("conflict", error.message)
              return rejected("unavailable", error.message)
            }),
          )
        if (approved.state === "completed" || approved.state === "failed" || approved.state === "unknown")
          return approved
        if (approved.state === "pushing") return approved
        const run = Effect.gen(function* () {
          if (approved.state === "approved") {
            const pushed = yield* Effect.result(
              options.executor.gateway.pushBranch({
                assignmentId: approved.assignmentId,
                publicationId: approved.id,
                ownerId: approved.ownerId,
                repositoryId: approved.repositoryId,
                workspaceId: approved.workspaceId,
                branch: approved.sourceBranch,
                ref: approved.sourceRef,
                commitSha: approved.sourceCommitSha,
              }),
            )
            if (pushed._tag === "Failure")
              return yield* repositories.recordPush(
                approved,
                { outcome: "unknown", authority: "assignment-workspace", reason: pushed.failure.kind },
                "unknown",
              )
            if (pushed.success._tag === "Failed")
              return yield* repositories.recordPush(
                approved,
                {
                  outcome: pushed.success.kind === "git" ? "unknown" : "failed",
                  authority: "assignment-workspace",
                  reason: pushed.success.kind,
                },
                pushed.success.kind === "git" ? "unknown" : "failed",
              )
            approved = yield* repositories.recordPush(
              approved,
              {
                outcome: "succeeded",
                authority: "assignment-workspace",
                branch: pushed.success.branch,
                ref: pushed.success.ref,
                commitSha: pushed.success.commitSha,
              },
              "pushed",
            )
          }
          return yield* pullRequest(approved)
        }).pipe(
          Effect.ensuring(repositories.revokePublicationCredential(approved.id).pipe(Effect.ignore)),
          Effect.mapError((error) => rejected("unavailable", error.message)),
        )
        return yield* Effect.uninterruptible(run)
      })

      return HostedPublication.of({ publish })
    }),
  )
