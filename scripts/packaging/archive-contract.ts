import { dual } from "effect/Function"

export const packageEntries = (root: string) =>
  [
    { name: `${root}/`, type: "d", executable: true },
    { name: `${root}/INSTALL`, type: "-", executable: false },
    { name: `${root}/bin/`, type: "d", executable: true },
    { name: `${root}/bin/.rika-interactive`, type: "-", executable: true },
    { name: `${root}/bin/.rika-performance`, type: "-", executable: true },
    { name: `${root}/bin/.rika-resident`, type: "-", executable: true },
    { name: `${root}/bin/rika`, type: "-", executable: true },
  ] as const

export const validatePackageArchive: {
  (root: string, namesOutput: string, detailsOutput: string): void
  (namesOutput: string, detailsOutput: string): (root: string) => void
} = dual(3, (root: string, namesOutput: string, detailsOutput: string): void => {
  const expected = packageEntries(root)
  const names = namesOutput.trim().split("\n")
  if (
    names.length !== expected.length ||
    names.toSorted().join("\n") !==
      expected
        .map((entry) => entry.name)
        .toSorted()
        .join("\n")
  )
    throw new Error(`Unexpected archive inventory:\n${namesOutput}`)
  if (names.some((name) => name.startsWith("/") || name.includes("../")))
    throw new Error("Archive contains an unsafe path")

  const details = detailsOutput.trim().split("\n")
  if (details.length !== expected.length) throw new Error(`Unexpected archive headers:\n${detailsOutput}`)
  for (let index = 0; index < expected.length; index += 1) {
    const entry = expected.find((candidate) => candidate.name === names[index])!
    const mode = details[index]!.slice(0, 10)
    if (mode.length !== 10 || mode[0] !== entry.type)
      throw new Error(`Archive entry has an invalid type: ${entry.name}`)
    if (entry.executable && mode[3] !== "x" && mode[3] !== "s")
      throw new Error(`Archive entry is not executable: ${entry.name}`)
  }
})
