import { dual } from "effect/Function"
import { platformConstraints, platformPackageName } from "./npm-package-names"
import type { PackageTarget } from "./package-target-contract"

const shared = (version: string) => ({
  version,
  license: "MIT",
  repository: { type: "git", url: "git+https://github.com/In-Time-Tec/rika.git" },
  homepage: "https://github.com/In-Time-Tec/rika",
  engines: { node: ">=18" },
})

export const platformManifest: {
  (version: string): (target: PackageTarget) => Record<string, unknown>
  (target: PackageTarget, version: string): Record<string, unknown>
} = dual(2, (target: PackageTarget, version: string) => ({
  name: platformPackageName(target),
  description: `Rika binaries for ${target}`,
  ...shared(version),
  ...platformConstraints(target),
  files: ["bin/"],
  preferUnplugged: true,
}))
