import { dual } from "effect/Function"
import { targetNames, type PackageTarget } from "./package-target-contract"

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
