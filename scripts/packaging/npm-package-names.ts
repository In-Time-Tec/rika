import { dual } from "effect/Function"
import type { PackageTarget } from "./package-target-contract"

export const scope = "@rikafx"

export const launcherName = `${scope}/cli`

export const platformPackageName = (target: PackageTarget): string => `${scope}/cli-${target}`

export const platformConstraints = (target: PackageTarget): { readonly os: string; readonly cpu: string } => {
  const [os, cpu] = target.split("-")
  return { os: os!, cpu: cpu! }
}

export const packedName: {
  (version: string): (name: string) => string
  (name: string, version: string): string
} = dual(2, (name: string, version: string): string => `${name.replace("@", "").replace("/", "-")}-${version}.tgz`)
