import { Config, Crypto, Effect, Encoding, FileSystem, Function, Option, Path, PlatformError, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export const releaseRepository = "In-Time-Tec/rika"

export const releaseApiUrlEnv = "RIKA_RELEASE_API_URL"

export const releaseBaseUrlEnv = "RIKA_RELEASE_BASE_URL"

export const installRootEnv = "RIKA_INSTALL_ROOT"

export const developmentRootSegment = "rika-dev"

export const releaseTargets = ["darwin-arm64", "linux-arm64", "linux-x64"] as const

export type ReleaseTarget = (typeof releaseTargets)[number]

const operatingSystemNames: Readonly<Record<string, string>> = { darwin: "darwin", linux: "linux" }

const architectureNames: Readonly<Record<string, string>> = {
  aarch64: "arm64",
  amd64: "x64",
  arm64: "arm64",
  x64: "x64",
  x86_64: "x64",
}

export interface ReleaseHost {
  readonly platform: string
  readonly architecture: string
}

export const hostReleaseTarget = (host: ReleaseHost): ReleaseTarget | undefined => {
  const operatingSystem = operatingSystemNames[host.platform.trim().toLowerCase()]
  const processor = architectureNames[host.architecture.trim().toLowerCase()]
  if (operatingSystem === undefined || processor === undefined) return undefined
  const candidate = `${operatingSystem}-${processor}`
  return releaseTargets.find((target) => target === candidate)
}

export const archiveFileName: {
  (version: string, target: ReleaseTarget): string
  (target: ReleaseTarget): (version: string) => string
} = Function.dual(2, (version: string, target: ReleaseTarget) => `rika-${version}-${target}.tar.gz`)

export const archiveRootName: {
  (version: string, target: ReleaseTarget): string
  (target: ReleaseTarget): (version: string) => string
} = Function.dual(2, (version: string, target: ReleaseTarget) => `rika-${version}-${target}`)

export const releaseVersion = (tag: string): string => (tag.startsWith("v") ? tag.slice(1) : tag)

const numericVersionParts = (value: string): ReadonlyArray<number> | undefined => {
  const parts = value.split(".")
  if (parts.some((part) => !/^\d+$/.test(part))) return undefined
  return parts.map((part) => Number(part))
}

export interface ReleaseComparison {
  readonly current: string
  readonly latest: string
}

export const updateAvailable = (versions: ReleaseComparison): boolean => {
  if (versions.current === versions.latest) return false
  const currentParts = numericVersionParts(versions.current)
  const latestParts = numericVersionParts(versions.latest)
  if (currentParts === undefined || latestParts === undefined) return true
  const length = Math.max(currentParts.length, latestParts.length)
  for (let index = 0; index < length; index += 1) {
    const currentPart = currentParts[index] ?? 0
    const latestPart = latestParts[index] ?? 0
    if (currentPart !== latestPart) return currentPart < latestPart
  }
  return false
}

export interface ChecksumLookup {
  readonly checksums: string
  readonly file: string
}

export const publishedChecksum = (lookup: ChecksumLookup): string | undefined => {
  for (const line of lookup.checksums.split("\n")) {
    const fields = line.trim().split(/\s+/)
    const digest = fields[0]
    const name = fields[fields.length - 1]
    if (digest === undefined || name === undefined) continue
    if (name.replace(/^\*/, "") !== lookup.file) continue
    if (/^[0-9a-f]{64}$/.test(digest)) return digest
  }
  return undefined
}

export const UpdateFailure = Schema.Literals([
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

export type UpdateFailure = typeof UpdateFailure.Type

export class ReleaseUpdateError extends Schema.TaggedErrorClass<ReleaseUpdateError>()("ReleaseUpdateError", {
  failure: UpdateFailure,
  message: Schema.String,
}) {}

const failWith = (failure: UpdateFailure, message: string) => ReleaseUpdateError.make({ failure, message })

export interface InstallLayout {
  readonly installRoot: string
  readonly binary: string
  readonly runtime: string
}

export type UpdateOutcome =
  | { readonly _tag: "AlreadyCurrent"; readonly current: string; readonly latest: string }
  | {
      readonly _tag: "Updated"
      readonly current: string
      readonly latest: string
      readonly installRoot: string
    }

export const updateReport = (outcome: UpdateOutcome): string =>
  outcome._tag === "AlreadyCurrent"
    ? [
        `Current version: ${outcome.current}`,
        `Latest release: ${outcome.latest}`,
        "Already up to date; nothing was downloaded.",
      ].join("\n")
    : [
        `Current version: ${outcome.current}`,
        `Latest release: ${outcome.latest}`,
        `Replaced ${outcome.installRoot} with ${outcome.latest} after verifying its published SHA256 checksum.`,
        "Run rika again to start the new build.",
      ].join("\n")

const platformFailure = (operation: string) => (error: PlatformError.PlatformError) => {
  const tag = error.reason._tag
  if (tag === "PermissionDenied")
    return failWith(
      "permission-denied",
      `Cannot ${operation}: permission denied. Re-run with write access to the install directory.`,
    )
  if (tag === "Busy")
    return failWith(
      "install-in-use",
      `Cannot ${operation}: the installed files are in use. Stop running Rika and retry.`,
    )
  return failWith("install-failed", `Cannot ${operation}: ${error.message}`)
}

const installLayout = Effect.fn("ReleaseUpdate.installLayout")(function* (executable: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const configuredRoot = yield* Config.option(Config.string(installRootEnv)).pipe(
    Effect.mapError((error) => failWith("install-failed", `Cannot read ${installRootEnv}: ${error.message}`)),
  )
  const binDirectory = path.dirname(executable)
  const derivedRoot = path.dirname(binDirectory)
  const installRoot = Option.isSome(configuredRoot) ? path.resolve(configuredRoot.value) : derivedRoot
  if (Option.isNone(configuredRoot) && path.basename(binDirectory) !== "bin")
    return yield* failWith(
      "unmanaged-install",
      `This Rika is running from ${executable}, which is not a released install. Install a release with: curl -fsSL https://raw.githubusercontent.com/${releaseRepository}/main/install.sh | sh`,
    )
  if (installRoot.split(path.sep).includes(developmentRootSegment))
    return yield* failWith(
      "unmanaged-install",
      `This Rika is a source build installed at ${installRoot}. Rebuild it with: bun run install-local`,
    )
  if (installRoot.split(path.sep).includes("node_modules"))
    return yield* failWith(
      "unmanaged-install",
      `This Rika was installed from npm at ${installRoot}. Update it with your package manager, for example: npm install -g @rikafx/cli@latest`,
    )
  const layout: InstallLayout = {
    installRoot,
    binary: path.join(installRoot, "bin", "rika"),
    runtime: path.join(installRoot, "bin", ".rika-runtime"),
  }
  const present = yield* Effect.all([fileSystem.exists(layout.binary), fileSystem.exists(layout.runtime)], {
    concurrency: 2,
  }).pipe(Effect.mapError(platformFailure("inspect the current install")))
  if (present.includes(false))
    return yield* failWith(
      "unmanaged-install",
      `${installRoot} does not contain bin/rika and bin/.rika-runtime, so it is not a released install. Install a release with: curl -fsSL https://raw.githubusercontent.com/${releaseRepository}/main/install.sh | sh`,
    )
  return layout
})

const LatestRelease = Schema.Struct({ tag_name: Schema.String })

const configuredUrl = Effect.fn("ReleaseUpdate.configuredUrl")(function* (variable: string) {
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

const latestReleaseVersion = Effect.fn("ReleaseUpdate.latestReleaseVersion")(function* (currentVersion: string) {
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

const downloadedText = Effect.fn("ReleaseUpdate.downloadedText")(function* (
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

const downloadedBytes = Effect.fn("ReleaseUpdate.downloadedBytes")(function* (
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

const publishInstall = Effect.fn("ReleaseUpdate.publishInstall")(function* (options: {
  readonly layout: InstallLayout
  readonly archive: Uint8Array
  readonly archiveFile: string
  readonly archiveRoot: string
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const parent = path.dirname(options.layout.installRoot)
  yield* fileSystem
    .makeDirectory(parent, { recursive: true })
    .pipe(Effect.mapError(platformFailure(`create ${parent}`)))
  const staging = yield* fileSystem
    .makeTempDirectoryScoped({ directory: parent, prefix: ".rika-update-" })
    .pipe(Effect.mapError(platformFailure(`stage the download beside ${options.layout.installRoot}`)))
  const stagedArchive = path.join(staging, options.archiveFile)
  yield* fileSystem
    .writeFile(stagedArchive, options.archive)
    .pipe(Effect.mapError(platformFailure(`write ${stagedArchive}`)))
  const exitCode = yield* spawner
    .exitCode(ChildProcess.make("tar", ["-xzf", stagedArchive, "-C", staging]))
    .pipe(Effect.mapError(platformFailure(`extract ${options.archiveFile}`)))
  if (Number(exitCode) !== 0)
    return yield* failWith("install-failed", `Cannot extract ${options.archiveFile}: tar exited with ${exitCode}.`)
  const payload = path.join(staging, options.archiveRoot)
  const payloadPresent = yield* Effect.all(
    [
      fileSystem.exists(path.join(payload, "bin", "rika")),
      fileSystem.exists(path.join(payload, "bin", ".rika-runtime")),
    ],
    { concurrency: 2 },
  ).pipe(Effect.mapError(platformFailure(`inspect ${options.archiveFile}`)))
  if (payloadPresent.includes(false))
    return yield* failWith(
      "install-failed",
      `${options.archiveFile} does not contain bin/rika and bin/.rika-runtime; the install was left unchanged.`,
    )
  const previous = path.join(parent, `${path.basename(options.layout.installRoot)}.previous-${process.pid}`)
  const installExists = yield* fileSystem
    .exists(options.layout.installRoot)
    .pipe(Effect.mapError(platformFailure(`inspect ${options.layout.installRoot}`)))
  if (installExists)
    yield* fileSystem
      .rename(options.layout.installRoot, previous)
      .pipe(Effect.mapError(platformFailure(`move the current install aside`)))
  yield* fileSystem.rename(payload, options.layout.installRoot).pipe(
    Effect.mapError(platformFailure(`publish the new install to ${options.layout.installRoot}`)),
    Effect.tapError(() =>
      installExists ? fileSystem.rename(previous, options.layout.installRoot).pipe(Effect.ignore) : Effect.void,
    ),
  )
  yield* fileSystem.remove(previous, { recursive: true, force: true }).pipe(Effect.ignore)
})

export interface UpdateOptions {
  readonly currentVersion: string
  readonly executable: string
  readonly host: ReleaseHost
}

export const update = Effect.fn("ReleaseUpdate.update")(function* (options: UpdateOptions) {
  const target = hostReleaseTarget(options.host)
  if (target === undefined)
    return yield* failWith(
      "unsupported-platform",
      `Rika has no release for ${options.host.platform}-${options.host.architecture}. Supported platforms: ${releaseTargets.join(", ")}.`,
    )
  const layout = yield* installLayout(options.executable)
  const latest = yield* latestReleaseVersion(options.currentVersion)
  if (!updateAvailable({ current: options.currentVersion, latest }))
    return { _tag: "AlreadyCurrent", current: options.currentVersion, latest } satisfies UpdateOutcome
  const baseOverride = yield* configuredUrl(releaseBaseUrlEnv)
  const base = Option.getOrElse(
    baseOverride,
    () => `https://github.com/${releaseRepository}/releases/download/v${latest}`,
  )
  const archiveFile = archiveFileName(latest, target)
  const checksums = yield* downloadedText(
    `${base}/SHA256SUMS`,
    options.currentVersion,
    `the SHA256SUMS for release v${latest}`,
    "release-unavailable",
  )
  const expected = publishedChecksum({ checksums, file: archiveFile })
  if (expected === undefined)
    return yield* failWith(
      "artifact-missing",
      `Release v${latest} does not publish ${archiveFile}; its SHA256SUMS lists no such artifact.`,
    )
  const archive = yield* downloadedBytes(
    `${base}/${archiveFile}`,
    options.currentVersion,
    `the release artifact ${archiveFile}`,
    "artifact-missing",
  )
  const crypto = yield* Crypto.Crypto
  const digest = yield* crypto
    .digest("SHA-256", archive)
    .pipe(Effect.mapError(platformFailure(`checksum ${archiveFile}`)))
  const actual = Encoding.encodeHex(digest)
  if (actual !== expected)
    return yield* failWith(
      "checksum-mismatch",
      `Checksum mismatch for ${archiveFile}; the download was discarded and the install was left unchanged.\n  expected ${expected}\n  actual   ${actual}`,
    )
  yield* Effect.scoped(publishInstall({ layout, archive, archiveFile, archiveRoot: archiveRootName(latest, target) }))
  return {
    _tag: "Updated",
    current: options.currentVersion,
    latest,
    installRoot: layout.installRoot,
  } satisfies UpdateOutcome
})
