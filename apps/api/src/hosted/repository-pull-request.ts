import type { RepositoryToken } from "@rika/github-app/installation-token"
import type { RepositoryBinding } from "@rika/product-store/repositories"
import { Effect, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { HostedRepositoryError, type HostedRepositoriesService } from "./repository-contract"

const Commit = Schema.Struct({ sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)) })
const PullRequest = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  html_url: Schema.NonEmptyString,
  head: Commit,
  base: Schema.Struct({ ref: Schema.NonEmptyString }),
})
type Input = Parameters<HostedRepositoriesService["createPullRequest"]>[0]

const failure = (reason: HostedRepositoryError["reason"], message: string) =>
  HostedRepositoryError.make({ reason, message })

export const createPullRequestWithToken = Effect.fn("HostedRepositories.createPullRequestWithToken")(function* (
  input: Input,
  binding: RepositoryBinding,
  token: RepositoryToken,
  baseUrl: string | undefined,
  targetWithToken: (targetRef: string) => Effect.Effect<Input["target"], HostedRepositoryError>,
) {
  const client = yield* HttpClient.HttpClient
  const repositoryApiUrl = (path: string) =>
    `${baseUrl ?? "https://api.github.com"}/repos/${encodeURIComponent(binding.repositoryOwner)}/${encodeURIComponent(binding.repositoryName)}${path}`
  const githubRequest = (request: HttpClientRequest.HttpClientRequest, message: string) =>
    client
      .execute(
        HttpClientRequest.setHeaders(request, {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${Redacted.value(token.token)}`,
          "x-github-api-version": "2026-03-10",
        }),
      )
      .pipe(Effect.mapError(() => failure("github", message)))
  const currentTarget = yield* targetWithToken(input.target.ref)
  if (currentTarget.commitSha !== input.target.commitSha || currentTarget.protected !== input.target.protected)
    return yield* failure("authorization", "Pull request target changed after publication approval")
  const query = new URL(repositoryApiUrl("/pulls"))
  query.searchParams.set("state", "open")
  query.searchParams.set("head", `${binding.repositoryOwner}:${input.sourceBranch}`)
  query.searchParams.set("base", input.target.ref)
  const existingResponse = yield* githubRequest(
    HttpClientRequest.get(query.toString()),
    "Could not inspect existing pull requests",
  )
  if (existingResponse.status < 200 || existingResponse.status >= 300)
    return yield* failure("github", "GitHub rejected pull request inspection")
  const existing = yield* HttpClientResponse.schemaBodyJson(Schema.Array(PullRequest))(existingResponse).pipe(
    Effect.mapError(() => failure("github", "GitHub returned invalid pull request inspection")),
  )
  let pull = existing.find(
    (candidate) => candidate.head.sha === input.commitSha && candidate.base.ref === input.target.ref,
  )
  if (pull === undefined) {
    const create = HttpClientRequest.post(repositoryApiUrl("/pulls")).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        title: input.title,
        head: input.sourceBranch,
        base: input.target.ref,
        body: input.body,
      }),
    )
    const response = yield* githubRequest(create, "Could not create the pull request")
    if (response.status < 200 || response.status >= 300)
      return yield* failure("github", "GitHub rejected pull request creation")
    pull = yield* HttpClientResponse.schemaBodyJson(PullRequest)(response).pipe(
      Effect.mapError(() => failure("github", "GitHub returned an invalid pull request receipt")),
    )
  }
  if (pull.head.sha !== input.commitSha || pull.base.ref !== input.target.ref)
    return yield* failure("authorization", "Pull request receipt does not match the approved publication")
  return {
    number: pull.number,
    url: pull.html_url,
    commitSha: pull.head.sha,
    targetRef: pull.base.ref,
  }
})
