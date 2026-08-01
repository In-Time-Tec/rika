export const targets = {
  "darwin-arm64": { bun: "bun-darwin-arm64", opentuiLibc: "" },
  "linux-arm64": { bun: "bun-linux-arm64", opentuiLibc: "glibc" },
  "linux-x64": { bun: "bun-linux-x64", opentuiLibc: "glibc" },
} as const

export type PackageTarget = keyof typeof targets

export const targetNames = Object.keys(targets) as ReadonlyArray<PackageTarget>

export const isPackageTarget = (value: string): value is PackageTarget => Object.hasOwn(targets, value)
