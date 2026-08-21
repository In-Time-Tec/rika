import type { WorkspaceFileInspect, WorkspaceFileInspection } from "@rika/product/workspace-capability"
import { Context, Effect, Encoding, FileSystem, Layer, Option, Path, PlatformError } from "effect"

type FileRead =
  | { readonly _tag: "NotFile" }
  | { readonly _tag: "TooLarge" }
  | { readonly _tag: "Content"; readonly bytes: Uint8Array }

export interface Interface {
  readonly inspect: (request: WorkspaceFileInspect) => Effect.Effect<WorkspaceFileInspection>
}

export class WorkspaceFiles extends Context.Service<WorkspaceFiles, Interface>()(
  "@rika/remote-execution/workspace-files/WorkspaceFiles",
) {}

const rejected = (
  request: WorkspaceFileInspect,
  reason: Extract<WorkspaceFileInspection, { readonly _tag: "WorkspaceFileRejected" }>["reason"],
  message: string,
): WorkspaceFileInspection => ({
  _tag: "WorkspaceFileRejected",
  requestId: request.requestId,
  path: request.path,
  reason,
  message,
})

export const layer = (workspaceRoot: string): Layer.Layer<WorkspaceFiles, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    WorkspaceFiles,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const inspect = Effect.fn("WorkspaceFiles.inspect")(function* (request: WorkspaceFileInspect) {
        const workspace = yield* fileSystem.realPath(workspaceRoot).pipe(Effect.option)
        if (workspace._tag === "None") return rejected(request, "unavailable", "Workspace root is unavailable")
        const root = workspace.value
        if (path.isAbsolute(request.path)) return rejected(request, "invalid", "Workspace file path must be relative")
        const relative = path.normalize(request.path)
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || relative.includes("\0"))
          return rejected(request, "invalid", "Workspace file path is invalid")
        const candidate = path.resolve(root, request.path)
        if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`))
          return rejected(request, "invalid", "Workspace file path is outside the Workspace")
        const resolved = yield* fileSystem.realPath(candidate).pipe(Effect.option)
        if (resolved._tag === "None") return rejected(request, "not-found", "Workspace file does not exist")
        if (resolved.value !== root && !resolved.value.startsWith(`${root}${path.sep}`))
          return rejected(request, "invalid", "Workspace file path resolves outside the Workspace")
        const content = yield* Effect.scoped(
          fileSystem.open(resolved.value, { flag: "r" }).pipe(
            Effect.flatMap((file) =>
              file.stat.pipe(
                Effect.flatMap((info): Effect.Effect<FileRead, PlatformError.PlatformError> => {
                  if (info.type !== "File") return Effect.succeed<FileRead>({ _tag: "NotFile" })
                  const sizeBytes = Number(info.size)
                  if (!Number.isSafeInteger(sizeBytes) || sizeBytes > request.maximumBytes)
                    return Effect.succeed<FileRead>({ _tag: "TooLarge" })
                  return file.readAlloc(request.maximumBytes + 1).pipe(
                    Effect.map(
                      (bytes): FileRead => ({
                        _tag: "Content",
                        bytes: Option.getOrElse(bytes, () => new Uint8Array()),
                      }),
                    ),
                  )
                }),
              ),
            ),
            Effect.option,
          ),
        )
        if (content._tag === "None") return rejected(request, "unavailable", "Workspace file could not be read")
        if (content.value._tag === "NotFile") return rejected(request, "not-file", "Workspace path is not a file")
        if (content.value._tag === "TooLarge" || content.value.bytes.byteLength > request.maximumBytes)
          return rejected(request, "too-large", "Workspace file exceeds the requested byte limit")
        return {
          _tag: "WorkspaceFileContent" as const,
          requestId: request.requestId,
          path: request.path,
          sizeBytes: content.value.bytes.byteLength,
          contentBase64: Encoding.encodeBase64(content.value.bytes),
        }
      })
      return WorkspaceFiles.of({ inspect })
    }),
  )
