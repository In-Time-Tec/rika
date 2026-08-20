import * as GitHub from "./github-model"
import { Effect, Schema } from "effect"

export const InstallationEvent = Schema.Struct({
  action: Schema.Literals(["created", "deleted", "new_permissions_accepted", "suspend", "unsuspend"]),
  installation: GitHub.Installation,
  repositories: Schema.optionalKey(Schema.Array(GitHub.Repository)),
})
export type InstallationEvent = typeof InstallationEvent.Type

export const InstallationRepositoriesEvent = Schema.Struct({
  action: Schema.Literals(["added", "removed"]),
  installation: GitHub.Installation,
  repository_selection: Schema.Literals(["all", "selected"]),
  repositories_added: Schema.Array(GitHub.Repository),
  repositories_removed: Schema.Array(GitHub.Repository),
})
export type InstallationRepositoriesEvent = typeof InstallationRepositoriesEvent.Type

export const RepositoryEvent = Schema.Struct({
  action: Schema.Literals(["renamed", "archived", "deleted", "transferred"]),
  repository: GitHub.Repository,
  installation: Schema.optionalKey(Schema.NullOr(Schema.Struct({ id: GitHub.PositiveInt }))),
})
export type RepositoryEvent = typeof RepositoryEvent.Type

export const WebhookEventName = Schema.Literals(["installation", "installation_repositories", "repository"])
export type WebhookEventName = typeof WebhookEventName.Type

export type WebhookEvent =
  | { readonly _tag: "installation"; readonly payload: InstallationEvent }
  | { readonly _tag: "installation_repositories"; readonly payload: InstallationRepositoriesEvent }
  | { readonly _tag: "repository"; readonly payload: RepositoryEvent }

export type ReconciliationCommand =
  | {
      readonly _tag: "ReconcileInstallation"
      readonly installationId: number
      readonly reason:
        | "installation_created"
        | "installation_deleted"
        | "installation_suspended"
        | "installation_unsuspended"
        | "installation_new_permissions"
    }
  | {
      readonly _tag: "ReconcileInstallationRepositories"
      readonly installationId: number
      readonly hintedRepositoryIds: ReadonlyArray<number>
      readonly reason: "repositories_added" | "repositories_removed"
    }
  | {
      readonly _tag: "ReconcileRepository"
      readonly installationId: number | null
      readonly repositoryId: number
      readonly reason: "repository_renamed" | "repository_archived" | "repository_deleted" | "repository_transferred"
    }

export class WebhookEventError extends Schema.TaggedError<WebhookEventError>()("GitHubWebhookEventError", {
  eventName: Schema.String,
  message: Schema.String,
}) {}

const invalidEvent = (eventName: string) =>
  WebhookEventError.make({ eventName, message: "GitHub webhook payload is invalid" })

export const decodeWebhookEvent = Effect.fn("GitHubWebhookEvent.decode")(function* (
  eventName: WebhookEventName,
  body: string,
) {
  switch (eventName) {
    case "installation":
      return {
        _tag: eventName,
        payload: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InstallationEvent))(body).pipe(
          Effect.mapError(() => invalidEvent(eventName)),
        ),
      } satisfies WebhookEvent
    case "installation_repositories":
      return {
        _tag: eventName,
        payload: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InstallationRepositoriesEvent))(body).pipe(
          Effect.mapError(() => invalidEvent(eventName)),
        ),
      } satisfies WebhookEvent
    case "repository":
      return {
        _tag: eventName,
        payload: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RepositoryEvent))(body).pipe(
          Effect.mapError(() => invalidEvent(eventName)),
        ),
      } satisfies WebhookEvent
  }
})

const installationReason = (action: InstallationEvent["action"]) => {
  switch (action) {
    case "created":
      return "installation_created" as const
    case "deleted":
      return "installation_deleted" as const
    case "suspend":
      return "installation_suspended" as const
    case "unsuspend":
      return "installation_unsuspended" as const
    case "new_permissions_accepted":
      return "installation_new_permissions" as const
  }
}

const repositoryReason = (action: RepositoryEvent["action"]) => {
  switch (action) {
    case "renamed":
      return "repository_renamed" as const
    case "archived":
      return "repository_archived" as const
    case "deleted":
      return "repository_deleted" as const
    case "transferred":
      return "repository_transferred" as const
  }
}

export const reconciliationCommand = (event: WebhookEvent): ReconciliationCommand => {
  switch (event._tag) {
    case "installation":
      return {
        _tag: "ReconcileInstallation",
        installationId: event.payload.installation.id,
        reason: installationReason(event.payload.action),
      }
    case "installation_repositories":
      return {
        _tag: "ReconcileInstallationRepositories",
        installationId: event.payload.installation.id,
        hintedRepositoryIds: [
          ...new Set(
            [...event.payload.repositories_added, ...event.payload.repositories_removed].map(
              (repository) => repository.id,
            ),
          ),
        ].sort((a, b) => a - b),
        reason: event.payload.action === "added" ? "repositories_added" : "repositories_removed",
      }
    case "repository":
      return {
        _tag: "ReconcileRepository",
        installationId: event.payload.installation?.id ?? null,
        repositoryId: event.payload.repository.id,
        reason: repositoryReason(event.payload.action),
      }
  }
}
