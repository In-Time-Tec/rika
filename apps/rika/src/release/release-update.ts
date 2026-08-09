import { Config, Crypto, Effect, Encoding, Function, Option } from "effect"
import { downloadedBytes, downloadedText, failWith, latestReleaseVersion, releaseBaseUrlEnv } from "./release-download"
import { installLayout, publishInstall } from "./release-install"

const releaseRepository = "In-Time-Tec/rika"
const releaseTargets = ["darwin-arm64", "linux-arm64", "linux-x64"] as const
type ReleaseTarget = (typeof releaseTargets)[number]
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
  return releaseTargets.find((target) => target === `${operatingSystem}-${processor}`)
}
const archiveFileNameImpl = (version: string, target: ReleaseTarget): string => `rika-${version}-${target}.tar.gz`
export const archiveFileName: {
  (target: ReleaseTarget): (version: string) => string
  (version: string, target: ReleaseTarget): string
} = Function.dual(2, archiveFileNameImpl)
const archiveRootNameImpl = (version: string, target: ReleaseTarget): string => `rika-${version}-${target}`
export const archiveRootName: {
  (target: ReleaseTarget): (version: string) => string
  (version: string, target: ReleaseTarget): string
} = Function.dual(2, archiveRootNameImpl)
export const releaseVersion = (tag: string): string => (tag.startsWith("v") ? tag.slice(1) : tag)
const numericVersionParts = (value: string): ReadonlyArray<number> | undefined => {
  const parts = value.split(".")
  if (parts.some((part) => !/^\d+$/.test(part))) return undefined
  return parts.map(Number)
}
interface ReleaseComparison {
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
interface ChecksumLookup {
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
const configuredUrl = Effect.fn("ReleaseUpdate.configuredUrl")(function* (variable: string) {
  const value = yield* Config.option(Config.string(variable)).pipe(
    Effect.mapError((error) => failWith("install-failed", `Cannot read ${variable}: ${error.message}`)),
  )
  return Option.map(value, (url) => url.replace(/\/+$/, ""))
})

interface UpdateOptions {
  readonly currentVersion: string
  readonly executable: string
  readonly host: ReleaseHost
}
type UpdateOutcome =
  | { readonly _tag: "AlreadyCurrent"; readonly current: string; readonly latest: string }
  | { readonly _tag: "Updated"; readonly current: string; readonly latest: string; readonly installRoot: string }

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
    .pipe(Effect.mapError((error) => failWith("install-failed", `Cannot checksum release artifact: ${error.message}`)))
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
