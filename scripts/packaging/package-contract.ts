import { dual } from "effect/Function"

export const targets = {
  "darwin-arm64": { bun: "bun-darwin-arm64", opentuiLibc: "" },
  "linux-arm64": { bun: "bun-linux-arm64", opentuiLibc: "glibc" },
  "linux-x64": { bun: "bun-linux-x64", opentuiLibc: "glibc" },
} as const

export type PackageTarget = keyof typeof targets

export const isPackageTarget = (value: string): value is PackageTarget => Object.hasOwn(targets, value)

export const targetNames = Object.keys(targets).filter(isPackageTarget)

export const archiveName: {
  (version: string, target: PackageTarget): string
  (target: PackageTarget): (version: string) => string
} = dual(2, (version: string, target: PackageTarget) => `rika-${version}-${target}.tar.gz`)

export const archiveRoot: {
  (version: string, target: PackageTarget): string
  (target: PackageTarget): (version: string) => string
} = dual(2, (version: string, target: PackageTarget) => `rika-${version}-${target}`)

export const expectedArchiveNames = (version: string) => targetNames.map((target) => archiveName(version, target))

export const ownedTargetEntries: {
  (version: string, target: PackageTarget): ReadonlyArray<string>
  (target: PackageTarget): (version: string) => ReadonlyArray<string>
} = dual(2, (version: string, target: PackageTarget) => [archiveRoot(version, target), archiveName(version, target)])

export const validateArchiveSet: {
  (version: string, names: ReadonlyArray<string>): ReadonlyArray<string>
  (names: ReadonlyArray<string>): (version: string) => ReadonlyArray<string>
} = dual(2, (version: string, names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const expected = expectedArchiveNames(version)
  const actual = names.filter((name) => name.endsWith(".tar.gz")).toSorted()
  if (actual.join("\n") !== expected.toSorted().join("\n"))
    throw new Error(`Expected exact archive set: ${expected.join(", ")}; found: ${actual.join(", ")}`)
  return expected
})

export interface ReleaseArtifact {
  readonly target: PackageTarget
  readonly archive: string
  readonly sha256: string
  readonly bytes: number
}

export interface ReleaseEvidence {
  readonly schemaVersion: 1
  readonly version: string
  readonly revision: string
  readonly bun: string
  readonly artifacts: ReadonlyArray<ReleaseArtifact>
}
