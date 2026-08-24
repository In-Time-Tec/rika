import { Effect, FileSystem, Function, Path, PlatformError } from "effect"
import type { WorkspaceListEntry } from "../../runtime/result/value"

export const maximumEntries = 1_000

const ignoredNames = new Set([".git", ".rika", ".worktrees", "dist", "node_modules"])

export interface Options {
  readonly depth: number
  readonly maximumEntries?: number
}

export interface Listing {
  readonly text: string
  readonly entries: ReadonlyArray<WorkspaceListEntry>
  readonly truncated: boolean
}

const renderEntries = (entries: ReadonlyArray<WorkspaceListEntry>, prefix = ""): ReadonlyArray<string> =>
  entries.flatMap((entry, index) => {
    const last = index === entries.length - 1
    const line = `${prefix}${last ? "└── " : "├── "}${entry.name}${entry.kind === "directory" ? "/" : ""}`
    if (entry.kind !== "directory") return [line]
    return [line, ...renderEntries(entry.entries, `${prefix}${last ? "    " : "│   "}`)]
  })

const listImpl = (target: string, displayPath: string, options: Options) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const limit = Math.max(1, options.maximumEntries ?? maximumEntries)
    let count = 0
    let depthLimited = false
    let entryLimited = false
    const root = yield* fileSystem.realPath(target)
    const visitedDirectories = new Set([root])
    const contained = (candidate: string) => {
      if (candidate === root) return true
      const relative = path.relative(root, candidate)
      return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
    }

    const walk = (
      directory: string,
      level: number,
    ): Effect.Effect<ReadonlyArray<WorkspaceListEntry>, PlatformError.PlatformError> =>
      Effect.gen(function* () {
        const names = (yield* fileSystem.readDirectory(directory))
          .filter((name) => !ignoredNames.has(name))
          .toSorted((left, right) => left.localeCompare(right))
        const entries: Array<WorkspaceListEntry> = []
        for (const name of names) {
          if (count >= limit) {
            entryLimited = true
            break
          }
          const child = path.join(directory, name)
          const info = yield* fileSystem.stat(child)
          count += 1
          if (info.type !== "Directory") {
            entries.push({ name, kind: "file" })
            continue
          }
          const canonical = yield* fileSystem.realPath(child)
          if (!contained(canonical) || visitedDirectories.has(canonical)) {
            entries.push({ name, kind: "file" })
            continue
          }
          visitedDirectories.add(canonical)
          if (level >= options.depth) {
            const descendants = (yield* fileSystem.readDirectory(child)).some((value) => !ignoredNames.has(value))
            if (descendants) depthLimited = true
            entries.push({ name, kind: "directory", entries: [] })
            continue
          }
          entries.push({ name, kind: "directory", entries: yield* walk(child, level + 1) })
        }
        return entries
      })

    const entries = yield* walk(target, 1)
    const reasons = [
      depthLimited ? `requested depth ${options.depth} hid descendants; increase depth up to 8` : undefined,
      entryLimited ? `entry cap ${limit} was reached; list a narrower path` : undefined,
    ].filter((reason): reason is string => reason !== undefined)
    const label = displayPath.length === 0 ? "." : displayPath
    const tree = [`${label}${label.endsWith("/") ? "" : "/"}`, ...renderEntries(entries)].join("\n")
    return {
      text: reasons.length === 0 ? tree : `${tree}\n[truncated: ${reasons.join("; ")}]`,
      entries,
      truncated: reasons.length > 0,
    }
  })

export const list: {
  (
    target: string,
    displayPath: string,
    options: Options,
  ): Effect.Effect<Listing, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>
  (
    displayPath: string,
    options: Options,
  ): (target: string) => Effect.Effect<Listing, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>
} = Function.dual(3, listImpl)
