export const upstreamPackages: ReadonlyArray<{ readonly name: string; readonly directory: string }> = [
  { name: "@batonfx/core", directory: "batonfx/packages/core" },
  { name: "@batonfx/mcp", directory: "batonfx/packages/mcp" },
  { name: "@batonfx/providers", directory: "batonfx/packages/providers" },
  { name: "@batonfx/runtime", directory: "batonfx/packages/runtime" },
  { name: "@batonfx/skills", directory: "batonfx/packages/skills" },
  { name: "@batonfx/test", directory: "batonfx/packages/test" },
]

export const tarballDirectory = "artifacts/upstream"

export const tarballPrefix = (name: string) => `${name.replace("@", "").replace("/", "-")}-`

// The packed content digest is part of the tarball name because Bun keys its install cache on the
// tarball path, not on the bytes at that path. A stable name therefore pins the first extraction
// forever, which is exactly how a rebuilt sibling silently kept shipping its previous dist.
export const packedTarballName = (packed: { readonly name: string; readonly digest: string }) =>
  `${packed.name.replace(/\.tgz$/, "")}-${packed.digest}.tgz`
