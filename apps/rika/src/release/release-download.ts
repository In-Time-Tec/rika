import { Config, Effect, Option, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"

const releaseRepository = "In-Time-Tec/rika"
const releaseVersion = (tag: string): string => (tag.startsWith("v") ? tag.slice(1) : tag)
export const releaseApiUrlEnv = "RIKA_RELEASE_API_URL"
export const releaseBaseUrlEnv = "RIKA_RELEASE_BASE_URL"
const UpdateFailure = Schema.Literals([
  "unsupported-platform",
  "unmanaged-install",
  "network",
  "rate-limited",
  "release-unavailable",
  "artifact-missing",
  "checksum-mismatch",
  "permission-denied",
  "install-in-use",
  "install-failed",
])
type UpdateFailure = typeof UpdateFailure.Type

export class ReleaseUpdateError extends Schema.TaggedErrorClass<ReleaseUpdateError>()("ReleaseUpdateError", {
  failure: UpdateFailure,
  message: Schema.String,
}) {}

export const failWith = (failure: UpdateFailure, message: string) => ReleaseUpdateError.make({ failure, message })

const configuredUrl = Effect.fn("ReleaseDownload.configuredUrl")(function* (variable: string) {
  const value = yield* Config.option(Config.string(variable)).pipe(
    Effect.mapError((error) => failWith("install-failed", `Cannot read ${variable}: ${error.message}`)),
  )
  return Option.map(value, (url) => url.replace(/\/+$/, ""))
})

const requestHeaders = (currentVersion: string) => ({
  "user-agent": `rika/${currentVersion}`,
  accept: "application/vnd.github+json",
})
const transportFailure = (description: string) => () =>
  failWith("network", `Cannot reach ${description}. Check your network connection and retry.`)

const LatestRelease = Schema.Struct({ tag_name: Schema.String })
export const latestReleaseVersion = Effect.fn("ReleaseDownload.latestReleaseVersion")(function* (
  currentVersion: string,
) {
  const apiOverride = yield* configuredUrl(releaseApiUrlEnv)
  const url = Option.getOrElse(apiOverride, () => `https://api.github.com/repos/${releaseRepository}/releases/latest`)
  const response = yield* HttpClient.get(url, { headers: requestHeaders(currentVersion) }).pipe(
    Effect.mapError(transportFailure("the GitHub releases API")),
  )
  if (response.status === 429 || (response.status === 403 && response.headers["x-ratelimit-remaining"] === "0"))
    return yield* failWith(
      "rate-limited",
      "The GitHub API rate limit is exhausted for this network. Wait for it to reset, or set RIKA_VERSION and re-run the installer.",
    )
  if (response.status < 200 || response.status >= 300)
    return yield* failWith(
      "release-unavailable",
      `The GitHub releases API answered ${response.status} for ${releaseRepository}. No release was resolved.`,
    )
  const body = yield* response.text.pipe(Effect.mapError(transportFailure("the GitHub releases API")))
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LatestRelease))(body).pipe(
    Effect.mapError(() =>
      failWith("release-unavailable", "The GitHub releases API returned a response without a release tag."),
    ),
  )
  const version = releaseVersion(decoded.tag_name)
  if (version.length === 0)
    return yield* failWith("release-unavailable", "The latest GitHub release has an empty tag name.")
  return version
})

export const downloadedText = Effect.fn("ReleaseDownload.text")(function* (
  url: string,
  currentVersion: string,
  description: string,
  missing: UpdateFailure,
) {
  const response = yield* HttpClient.get(url, { headers: requestHeaders(currentVersion) }).pipe(
    Effect.mapError(transportFailure(description)),
  )
  if (response.status < 200 || response.status >= 300)
    return yield* failWith(missing, `${description} is not available (HTTP ${response.status}) at ${url}.`)
  return yield* response.text.pipe(Effect.mapError(transportFailure(description)))
})

export const downloadedBytes = Effect.fn("ReleaseDownload.bytes")(function* (
  url: string,
  currentVersion: string,
  description: string,
  missing: UpdateFailure,
) {
  const response = yield* HttpClient.get(url, { headers: requestHeaders(currentVersion) }).pipe(
    Effect.mapError(transportFailure(description)),
  )
  if (response.status < 200 || response.status >= 300)
    return yield* failWith(missing, `${description} is not available (HTTP ${response.status}) at ${url}.`)
  const buffer = yield* response.arrayBuffer.pipe(Effect.mapError(transportFailure(description)))
  return new Uint8Array(buffer)
})
