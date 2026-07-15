import { createHash } from "node:crypto"
import { Context, Effect, Layer, Path, PlatformError, Schema } from "effect"
import * as ContextFileSystem from "./context-file-system"

export const Diagnostic = Schema.Struct({
  _tag: Schema.Literals(["PathOutsideWorkspace", "ReferenceNotFound", "ReferenceReadFailed"]),
  path: Schema.String,
  message: Schema.String,
})
export type Diagnostic = typeof Diagnostic.Type

export const Source = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["guidance", "reference"]),
  content: Schema.String,
  digest: Schema.String,
})
export type Source = typeof Source.Type
export interface Result {
  readonly sources: ReadonlyArray<Source>
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly digest: string
}
export interface Input {
  readonly workspace: string
  readonly targetPaths?: ReadonlyArray<string>
  readonly references?: ReadonlyArray<string>
}
const maximumReferenceFiles = 1_000
const maximumReferenceDepth = 32
export interface Interface {
  readonly resolve: (input: Input) => Effect.Effect<Result, PlatformError.PlatformError>
}
export class Service extends Context.Service<Service, Interface>()("@rika/app/resolved-context/Service") {}

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const globPattern = (value: string) => value.includes("*")
const globRegex = (pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("**", "\u0000")
      .replaceAll("*", "[^/]*")
      .replaceAll("\u0000", ".*")}$`,
  )

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fileSystem = yield* ContextFileSystem.Service
    const path = yield* Path.Path
    const resolve = Effect.fn("ResolvedContext.resolve")(function* (input: Input) {
      const root = path.resolve(input.workspace)
      const contained = (candidate: string) =>
        candidate === root ||
        (!path.relative(root, candidate).startsWith("..") &&
          !path.resolve(path.relative(root, candidate)).startsWith(".."))
      const diagnostics: Array<Diagnostic> = []
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
          if (yield* fileSystem.exists(candidate)) {
            selected.set(candidate, "guidance")
            break
          }
        }
      }
      const walk = Effect.fn("ResolvedContext.walk")(function* (
        directory: string,
        depth = 0,
      ): Effect.fn.Return<ReadonlyArray<string>> {
        if (depth > maximumReferenceDepth) return []
        const entries = (yield* fileSystem.readDirectory(directory))?.toSorted() ?? []
        const nested: Array<string> = []
        for (const entry of entries) {
          if (nested.length >= maximumReferenceFiles) break
          const candidate = path.resolve(directory, entry)
          if (!contained(candidate)) continue
          if ((yield* fileSystem.readDirectory(candidate)) !== undefined)
            nested.push(...(yield* walk(candidate, depth + 1)))
          else nested.push(candidate)
        }
        return nested.slice(0, maximumReferenceFiles)
      })
      const allFiles = input.references?.some(globPattern) === true ? yield* walk(root) : []
      for (const reference of [...(input.references ?? [])].toSorted()) {
        const candidates = globPattern(reference)
          ? allFiles.filter((candidate) => globRegex(reference).test(path.relative(root, candidate)))
          : [path.resolve(root, reference)]
        if (candidates.length === 0)
          diagnostics.push({
            _tag: "ReferenceNotFound",
            path: reference,
            message: "Referenced path did not match a file",
          })
        for (const candidate of candidates.toSorted()) {
          if (!contained(candidate))
            diagnostics.push({
              _tag: "PathOutsideWorkspace",
              path: candidate,
              message: "Referenced path is outside the Workspace",
            })
          else if (!(yield* fileSystem.exists(candidate)))
            diagnostics.push({ _tag: "ReferenceNotFound", path: candidate, message: "Referenced file does not exist" })
          else selected.set(candidate, "reference")
        }
      }
      const sources: Array<Source> = []
      for (const [name, kind] of [...selected].toSorted(([a], [b]) => a.localeCompare(b))) {
        const read = yield* Effect.result(fileSystem.readFileString(name))
        if (read._tag === "Failure")
          diagnostics.push({ _tag: "ReferenceReadFailed", path: name, message: "Context file could not be read" })
        else
          sources.push({
            path: path.relative(root, name) || path.basename(name),
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
