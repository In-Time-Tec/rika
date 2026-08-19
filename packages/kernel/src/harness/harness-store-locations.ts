import { FileSystemHarnessStore, type HarnessStore } from "tenetkit/harness"
import { globalDirectory, workspaceDirectory } from "@rika/configuration/configuration-paths"
import type { FileSystem, Layer, Path as EffectPath } from "effect"
import { scopeName } from "./harness-scope-policy"

/**
 * Where one harness scope's file lives. `@rika/extensions` cannot own this: the package boundary
 * forbids it importing `@rika/configuration` or `tenetkit/harness`, so the kernel owns the location
 * decision `FileSystemHarnessStore` delegates to its host.
 */
export interface Roots {
  readonly home: string
  readonly workspace: string
  readonly dataRoot: string
}

const under = (root: string, ...segments: ReadonlyArray<string>): string =>
  [root.endsWith("/") ? root.slice(0, -1) : root, ...segments].join("/")

const directory = (scope: string, roots: Roots): string => {
  const name = scopeName(scope)
  if (name === "global") return under(roots.home, globalDirectory, "harness")
  if (name === "workspace") return under(roots.workspace, workspaceDirectory, "harness")
  if (name === "thread") return under(roots.dataRoot, "harness")
  throw new TypeError(`Unrecognized harness scope: ${scope}`)
}

/** One scope string to one owner-only JSON file. The scope is encoded so `:` never becomes a path. */
export const path =
  (roots: Roots) =>
  (scope: string): string =>
    under(directory(scope, roots), `${encodeURIComponent(scope)}.json`)

/** The durable per-scope harness store every Thread refines through. */
export const layer = (
  roots: Roots,
): Layer.Layer<HarnessStore.HarnessStore, never, FileSystem.FileSystem | EffectPath.Path> =>
  FileSystemHarnessStore.layer({ path: path(roots) })
