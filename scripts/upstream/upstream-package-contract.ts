export const upstreamPackages: ReadonlyArray<{ readonly name: string; readonly directory: string }> = [
  { name: "tenetkit", directory: "tenetkit/packages/tenetkit" },
]

export const tarballDirectory = "artifacts/upstream"

export const tarballPrefix = (name: string) => `${name.replace("@", "").replace("/", "-")}-`

// The packed content digest is part of the tarball name because Bun keys its install cache on the
// tarball path, not on the bytes at that path. A stable name therefore pins the first extraction
// forever, which is exactly how a rebuilt sibling silently kept shipping its previous dist.
export const packedTarballName = (packed: { readonly name: string; readonly digest: string }) =>
  `${packed.name.replace(/\.tgz$/, "")}-${packed.digest}.tgz`
