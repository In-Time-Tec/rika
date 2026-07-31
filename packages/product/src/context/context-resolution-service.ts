import { createHash } from "node:crypto"
import { Context, Effect, FileSystem, Layer, Path, PlatformError } from "effect"
import * as LocalPath from "@rika/coding-tools/local-path"
import * as ContextFileSystem from "./context-file-system"
import { Diagnostic, Source } from "./resolved-context"
import type { Input, Result } from "./resolved-context"
const maximumReferenceFiles = 1_000
export type GlobLookup = (
  workspace: string,
  pattern: string,
  maximumFiles: number,
) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>
export interface Interface {
  readonly resolve: (input: Input) => Effect.Effect<Result, PlatformError.PlatformError>
}
export class Service extends Context.Service<Service, Interface>()("@rika/product/context/context-resolution-service/Service") {}

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const globPattern = (value: string) => value.includes("*")

export const layer = (glob: GlobLookup) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fileSystem = yield* ContextFileSystem.Service
      const path = yield* Path.Path
      const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
      const resolve = Effect.fn("ResolvedContext.resolve")(function* (input: Input) {
        const root = yield* fileSystem.realPath(path.resolve(input.workspace))
        const contained = (candidate: string) =>
          candidate === root ||
          (!path.relative(root, candidate).startsWith("..") &&
            !path.resolve(path.relative(root, candidate)).startsWith(".."))
        const displayPath = (from: string, name: string) => {
          const relative = path.relative(from, name)
          return relative.length === 0 ? path.basename(name) : relative
        }
        const lookup: LocalPath.Lookup = {
          exists: (candidate) => fileSystem.exists(candidate),
          readDirectory: (candidate) =>
            fileSystem.readDirectory(candidate).pipe(Effect.map((entries) => entries ?? [])),
        }
        const diagnostics: Array<Diagnostic> = []
        const physicallyContained = Effect.fn("ResolvedContext.physicallyContained")(function* (candidate: string) {
          const resolved = yield* Effect.option(fileSystem.realPath(candidate))
          return resolved._tag === "Some" && contained(resolved.value)
        })
        const selected = new Map<string, "guidance" | "reference">()
        const targets = [...(input.targetPaths ?? [])]
          .map((target) => path.resolve(root, target))
          .filter((target) => {
            if (contained(target)) return true
            diagnostics.push({
              _tag: "PathOutsideWorkspace",
              path: target,
              message: "Target path is outside the Workspace",
            })
            return false
          })
        const directories = new Set([root])
        for (const target of targets) {
          let directory = path.dirname(target)
          while (contained(directory)) {
            directories.add(directory)
            if (directory === root) break
            directory = path.dirname(directory)
          }
        }
        for (const directory of [...directories].toSorted((a, b) => a.length - b.length || a.localeCompare(b))) {
          for (const name of ["AGENTS.md", "AGENT.md", "CLAUDE.md"]) {
            const candidate = path.resolve(directory, name)
            if ((yield* fileSystem.exists(candidate)) && (yield* physicallyContained(candidate))) {
              selected.set(candidate, "guidance")
              break
            }
          }
        }
        const globCandidates = new Set<string>()
        for (const reference of [...(input.references ?? [])].toSorted()) {
          const candidates = globPattern(reference)
            ? (yield* glob(root, reference, maximumReferenceFiles).pipe(Effect.provideContext(platform)))
                .map((candidate) => path.resolve(root, candidate))
                .toSorted()
                .filter((candidate) => {
                  if (globCandidates.has(candidate)) return true
                  if (globCandidates.size >= maximumReferenceFiles) return false
                  globCandidates.add(candidate)
                  return true
                })
            : [
                yield* LocalPath.resolveExistingPath(lookup, reference, { path, base: root }).pipe(
                  Effect.orElseSucceed(() => path.resolve(root, reference)),
                ),
              ]
          if (candidates.length === 0)
            diagnostics.push({
              _tag: "ReferenceNotFound",
              path: reference,
              message: "Referenced path did not match a file",
            })
          for (const candidate of candidates.toSorted()) {
            if (yield* fileSystem.exists(candidate)) selected.set(candidate, "reference")
            else
              diagnostics.push({
                _tag: "ReferenceNotFound",
                path: candidate,
                message: "Referenced file does not exist",
              })
          }
        }
        const sources: Array<Source> = []
        for (const [name, kind] of [...selected].toSorted(([a], [b]) => a.localeCompare(b))) {
          const read = yield* Effect.result(fileSystem.readFileString(name))
          if (read._tag === "Failure")
            diagnostics.push({ _tag: "ReferenceReadFailed", path: name, message: "Context file could not be read" })
          else
            sources.push({
              path: contained(name) ? displayPath(root, name) : name,
              kind,
              content: read.success,
              digest: digest(read.success),
            })
        }
        const orderedDiagnostics = diagnostics.toSorted(
          (a, b) => a.path.localeCompare(b.path) || a._tag.localeCompare(b._tag),
        )
        return {
          sources,
          diagnostics: orderedDiagnostics,
          digest: digest(sources.map((source) => `${source.kind}\0${source.path}\0${source.digest}`).join("\n")),
        }
      })
      return Service.of({ resolve })
    }),
  )

export const testLayer = (implementation: Interface) => Layer.succeed(Service, Service.of(implementation))
