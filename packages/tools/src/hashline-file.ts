import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { PermissionPolicy, ToolExecutor, ToolRegistry } from "@rika/agent"
import { Config, Diagnostics } from "@rika/core"
import { Common } from "@rika/schema"
import type { Call } from "@rika/schema/tool"
import { parseDiffFromFile, type FileContents } from "@pierre/diffs"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"

const defaultMaxReadBytes = 100_000
const hashLength = 4
const anchorPattern = /^(\d+):([A-Za-z0-9_-]{4})$/
const displayAnchorPrefixPattern = /^[+-]?\d+:[A-Za-z0-9_-]{4}\|/
const bareHashPrefixPattern = /^[+-]?[A-Za-z0-9_-]{4}\|/
const diffLineNumberPrefixPattern = /^[+-]\d+\s/

export interface ReadInput extends Schema.Schema.Type<typeof ReadInput> {}
export const ReadInput = Schema.Struct({
  path: Schema.String,
  start_line: Schema.optionalKey(Schema.Int),
  end_line: Schema.optionalKey(Schema.Int),
  max_output_bytes: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "Rika.Tools.HashlineFile.ReadInput" })

export interface WriteInput extends Schema.Schema.Type<typeof WriteInput> {}
export const WriteInput = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  overwrite: Schema.optionalKey(Schema.Boolean),
  max_anchor_bytes: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "Rika.Tools.HashlineFile.WriteInput" })

export const EditOperationType = Schema.Literals([
  "set_line",
  "replace_range",
  "insert_before",
  "insert_after",
  "delete_range",
  "replace_text",
]).annotate({ identifier: "Rika.Tools.HashlineFile.EditOperationType" })
export type EditOperationType = typeof EditOperationType.Type

export interface EditOperation extends Schema.Schema.Type<typeof EditOperation> {}
export const EditOperation = Schema.Struct({
  type: EditOperationType,
  anchor: Schema.optionalKey(Schema.String),
  end_anchor: Schema.optionalKey(Schema.String),
  new_text: Schema.optionalKey(Schema.String),
  old_text: Schema.optionalKey(Schema.String),
  exact: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "Rika.Tools.HashlineFile.EditOperation" })

export interface EditInput extends Schema.Schema.Type<typeof EditInput> {}
export const EditInput = Schema.Struct({
  path: Schema.String,
  edits: Schema.Array(EditOperation),
  max_anchor_bytes: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "Rika.Tools.HashlineFile.EditInput" })

export class HashlineFileError extends Schema.TaggedErrorClass<HashlineFileError>()("HashlineFileError", {
  message: Schema.String,
  code: Schema.String,
  path: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  details: Schema.optional(Common.JsonValue),
}) {}

export interface Interface {
  readonly read: (input: ReadInput) => Effect.Effect<Common.JsonValue, HashlineFileError>
  readonly write: (input: WriteInput) => Effect.Effect<Common.JsonValue, HashlineFileError>
  readonly edit: (input: EditInput) => Effect.Effect<Common.JsonValue, HashlineFileError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tools/HashlineFile") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const values = yield* config.get
    const workspaceRoot = resolve(values.workspace_root)

    return Service.of({
      read: Effect.fn("HashlineFile.read")(function* (input: ReadInput) {
        const path = yield* resolveWorkspacePath(workspaceRoot, input.path)
        const snapshot = yield* readSnapshot(path)
        const anchors = buildAnchors(snapshot.lines)
        const range = yield* readRange(input, snapshot.lines.length, relativePath(workspaceRoot, path))
        const selectedAnchors = anchors.slice(range.startIndex, range.endIndex)
        const anchored = capReadAnchors(selectedAnchors, input.max_output_bytes ?? defaultMaxReadBytes)
        const selectedLines = anchored.anchors.map((anchor) => anchor.content)
        const startLine = anchored.anchors[0]?.line ?? range.startLine
        const endLine = anchored.anchors.at(-1)?.line ?? range.endLine

        return yield* jsonValue({
          type: "hashline.read",
          path: relativePath(workspaceRoot, path),
          content: anchored.anchors.map(formatAnchorLine).join("\n"),
          anchors: anchored.anchors.map(anchorToJson),
          range: {
            start_line: startLine,
            end_line: endLine,
          },
          total_lines: snapshot.lines.length,
          truncated: anchored.truncated,
          file: fileMetadata(snapshot),
          render: {
            kind: "file",
            renderer: "@pierre/diffs",
            collapsed: true,
            file: {
              name: relativePath(workspaceRoot, path),
              contents: selectedLines.join("\n"),
            },
          },
        })
      }),
      write: Effect.fn("HashlineFile.write")(function* (input: WriteInput) {
        const path = yield* resolveWorkspacePath(workspaceRoot, input.path)
        const before = yield* readExistingText(path)
        if (before.exists && input.overwrite === false) {
          return yield* new HashlineFileError({
            message: `File already exists: ${relativePath(workspaceRoot, path)}`,
            code: "E_FILE_EXISTS",
            path: relativePath(workspaceRoot, path),
            retryable: false,
          })
        }

        yield* atomicWrite(path, input.content)
        const after = yield* readSnapshot(path)
        const anchors = capAnchors(buildAnchors(after.lines), input.max_anchor_bytes ?? defaultMaxReadBytes)
        const diff = yield* pierreDiff(relativePath(workspaceRoot, path), before.text, input.content)

        return yield* jsonValue({
          type: "hashline.write",
          path: relativePath(workspaceRoot, path),
          created: !before.exists,
          bytes: new TextEncoder().encode(input.content).byteLength,
          anchors: anchors.anchors.map(anchorToJson),
          anchor_content: anchors.anchors.map(formatAnchorLine).join("\n"),
          anchors_truncated: anchors.truncated,
          diff,
        })
      }),
      edit: Effect.fn("HashlineFile.edit")(function* (input: EditInput) {
        const path = yield* resolveWorkspacePath(workspaceRoot, input.path)
        if (input.edits.length === 0) {
          return yield* new HashlineFileError({
            message: "edit requires at least one operation",
            code: "E_EMPTY_EDIT",
            path: relativePath(workspaceRoot, path),
            retryable: false,
          })
        }

        const snapshot = yield* readSnapshot(path)
        const edited = yield* editSnapshot(snapshot, input.edits, relativePath(workspaceRoot, path))
        yield* atomicWrite(path, edited.text)
        const after = yield* readSnapshot(path)
        const freshAnchors = capAnchors(
          anchorsNearRange(buildAnchors(after.lines), edited.changedStartLine, edited.changedEndLine),
          input.max_anchor_bytes ?? defaultMaxReadBytes,
        )
        const diff = yield* pierreDiff(relativePath(workspaceRoot, path), snapshot.text, edited.text)

        return yield* jsonValue({
          type: "hashline.edit",
          path: relativePath(workspaceRoot, path),
          changed_range: {
            start_line: edited.changedStartLine,
            end_line: edited.changedEndLine,
          },
          anchors: freshAnchors.anchors.map(anchorToJson),
          anchor_content: freshAnchors.anchors.map(formatAnchorLine).join("\n"),
          anchors_truncated: freshAnchors.truncated,
          diff,
        })
      }),
    })
  }),
)

export const read = Effect.fn("HashlineFile.read.call")(function* (input: ReadInput) {
  const service = yield* Service
  return yield* service.read(input)
})

export const write = Effect.fn("HashlineFile.write.call")(function* (input: WriteInput) {
  const service = yield* Service
  return yield* service.write(input)
})

export const edit = Effect.fn("HashlineFile.edit.call")(function* (input: EditInput) {
  const service = yield* Service
  return yield* service.edit(input)
})

export const toolDefinitions = (service: Interface): ReadonlyArray<ToolRegistry.Definition> => [
  {
    tool: Tool.make("read", {
      description: "Read a text file with LINE:HASH|content anchors for safe follow-up edits.",
      parameters: ReadInput,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("HashlineFile.tool.read")(function* (call: Call) {
      const input = yield* decodeReadInput(call)
      return yield* service.read(input).pipe(Effect.mapError(toRegistryError("read")))
    }),
  },
  {
    tool: Tool.make("write", {
      description: "Atomically write a text file and return fresh hashline anchors plus Pierre diff metadata.",
      parameters: WriteInput,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("HashlineFile.tool.write")(function* (call: Call) {
      const input = yield* decodeWriteInput(call)
      return yield* service.write(input).pipe(Effect.mapError(toRegistryError("write")))
    }),
  },
  {
    tool: Tool.make("edit", {
      description: "Apply strict hashline edits. Stale anchors fail; exact replacement requires exact: true.",
      parameters: EditInput,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("HashlineFile.tool.edit")(function* (call: Call) {
      const input = yield* decodeEditInput(call)
      return yield* service.edit(input).pipe(Effect.mapError(toRegistryError("edit")))
    }),
  },
]

export const registryLayer: Layer.Layer<ToolRegistry.Service, never, Config.Service> = Layer.effect(
  ToolRegistry.Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const values = yield* config.get
    const service = yield* Service
    const definitions = [...ToolRegistry.shellDefinitions(values.workspace_root), ...toolDefinitions(service)]
    return yield* ToolRegistry.Service.pipe(Effect.provide(ToolRegistry.layerFromDefinitions(definitions)))
  }),
).pipe(Layer.provideMerge(layer))

export const toolExecutorLayer: Layer.Layer<ToolExecutor.Service, never, Config.Service | Diagnostics.Service> =
  ToolExecutor.layer.pipe(Layer.provideMerge(registryLayer), Layer.provideMerge(PermissionPolicy.allowLayer))

interface Anchor {
  readonly line: number
  readonly hash: string
  readonly anchor: string
  readonly content: string
}

interface Snapshot {
  readonly text: string
  readonly body: string
  readonly lines: ReadonlyArray<string>
  readonly lineEnding: "lf" | "crlf" | "mixed" | "none"
  readonly eol: "\n" | "\r\n"
  readonly hasBom: boolean
  readonly finalNewline: boolean
}

interface LineEdit {
  readonly start: number
  readonly end: number
  readonly newLines: ReadonlyArray<string>
  readonly order: number
}

const resolveWorkspacePath = (workspaceRoot: string, inputPath: string) =>
  Effect.try({
    try: () => {
      const resolved = resolve(workspaceRoot, inputPath)
      const rel = relative(workspaceRoot, resolved)
      if (rel.startsWith("..") || rel === ".." || rel.startsWith(`..${separator}`)) {
        throw new Error(`Path is outside the workspace: ${inputPath}`)
      }
      return resolved
    },
    catch: (cause) =>
      new HashlineFileError({
        message: cause instanceof Error ? cause.message : String(cause),
        code: "E_PATH_OUTSIDE_WORKSPACE",
        path: inputPath,
        retryable: false,
      }),
  })

const separator = "/"

const readSnapshot = (path: string) =>
  Effect.gen(function* () {
    const bytes = yield* Effect.tryPromise({
      try: () => readFile(path),
      catch: (cause) =>
        new HashlineFileError({
          message: cause instanceof Error ? cause.message : String(cause),
          code: "E_READ_FAILED",
          path,
          retryable: false,
        }),
    })

    if (isImagePath(path)) {
      return yield* new HashlineFileError({
        message: "Image files are not readable through hashline text tools yet",
        code: "E_UNSUPPORTED_IMAGE",
        path,
        retryable: false,
      })
    }

    if (isLikelyBinary(bytes)) {
      return yield* new HashlineFileError({
        message: "Binary files are not readable through hashline text tools",
        code: "E_BINARY_FILE",
        path,
        retryable: false,
      })
    }

    const text = yield* decodeUtf8(bytes, path)
    return snapshotFromText(text)
  })

const readExistingText = (path: string) =>
  Effect.gen(function* () {
    const exists = yield* Effect.promise(() =>
      stat(path)
        .then((entry) => entry.isFile())
        .catch(() => false),
    )
    if (!exists) return { exists: false, text: "" }
    const snapshot = yield* readSnapshot(path)
    return { exists: true, text: snapshot.text }
  })

const decodeUtf8 = (bytes: Uint8Array, path: string) =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    catch: (cause) =>
      new HashlineFileError({
        message: cause instanceof Error ? cause.message : String(cause),
        code: "E_TEXT_DECODE_FAILED",
        path,
        retryable: false,
      }),
  })

const snapshotFromText = (text: string): Snapshot => {
  const hasBom = text.startsWith("\uFEFF")
  const body = hasBom ? text.slice(1) : text
  const lineEnding = detectLineEnding(body)
  const eol = lineEnding === "crlf" ? "\r\n" : "\n"
  const normalized = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  const finalNewline = normalized.endsWith("\n")
  const withoutFinalNewline = finalNewline ? normalized.slice(0, -1) : normalized
  const lines = withoutFinalNewline.length === 0 ? [] : withoutFinalNewline.split("\n")
  return { text, body, lines, lineEnding, eol, hasBom, finalNewline }
}

const readRange = (input: ReadInput, totalLines: number, path: string) => {
  const startLine = input.start_line ?? 1
  const requestedEndLine = input.end_line ?? totalLines
  if (startLine < 1) {
    return new HashlineFileError({
      message: "start_line must be at least 1",
      code: "E_INVALID_RANGE",
      path,
      retryable: false,
    })
  }
  if (startLine > Math.max(totalLines, 1)) {
    return new HashlineFileError({
      message: "start_line must be within the file",
      code: "E_INVALID_RANGE",
      path,
      retryable: false,
    })
  }
  if (input.end_line !== undefined && input.end_line < 1) {
    return new HashlineFileError({
      message: "end_line must be at least 1",
      code: "E_INVALID_RANGE",
      path,
      retryable: false,
    })
  }
  if (input.end_line !== undefined && input.end_line < startLine) {
    return new HashlineFileError({
      message: "end_line must be at or after start_line",
      code: "E_INVALID_RANGE",
      path,
      retryable: false,
    })
  }
  const startIndex = Math.min(startLine - 1, totalLines)
  const endIndex = Math.min(Math.max(requestedEndLine, 0), totalLines)
  const endLine = Math.max(startLine, Math.min(requestedEndLine, totalLines))
  return Effect.succeed({
    startLine,
    endLine,
    startIndex,
    endIndex,
  })
}

const renderSnapshotText = (snapshot: Snapshot, lines: ReadonlyArray<string>) => {
  const body = lines.length === 0 ? "" : `${lines.join(snapshot.eol)}${snapshot.finalNewline ? snapshot.eol : ""}`
  return `${snapshot.hasBom ? "\uFEFF" : ""}${body}`
}

const editSnapshot = (snapshot: Snapshot, edits: ReadonlyArray<EditOperation>, path: string) =>
  hasExactReplace(edits) ? editByExactReplace(snapshot, edits, path) : editByAnchors(snapshot, edits, path)

const editByExactReplace = (snapshot: Snapshot, edits: ReadonlyArray<EditOperation>, path: string) =>
  Effect.gen(function* () {
    if (edits.some((operation) => operation.type !== "replace_text")) {
      return yield* new HashlineFileError({
        message: "replace_text exact edits cannot be mixed with anchored edits",
        code: "E_MIXED_EXACT_AND_ANCHORED_EDITS",
        path,
        retryable: false,
      })
    }

    let text = snapshot.text
    for (const operation of edits) {
      if (operation.old_text === undefined || operation.new_text === undefined || operation.exact !== true) {
        return yield* new HashlineFileError({
          message: "replace_text requires old_text, new_text, and exact: true",
          code: "E_EXACT_REPLACE_REQUIRED",
          path,
          retryable: false,
        })
      }
      yield* rejectPatchPrefixes(operation.new_text, path)
      const matches = countOccurrences(text, operation.old_text)
      if (matches !== 1) {
        return yield* new HashlineFileError({
          message: `replace_text expected exactly one match, found ${matches}`,
          code: "E_EXACT_REPLACE_NOT_UNIQUE",
          path,
          retryable: false,
        })
      }
      text = text.replace(operation.old_text, operation.new_text)
    }

    const changed = firstChangedLine(snapshot.text, text)
    return { text, changedStartLine: changed, changedEndLine: changed }
  })

const editByAnchors = (snapshot: Snapshot, edits: ReadonlyArray<EditOperation>, path: string) =>
  Effect.gen(function* () {
    const anchors = buildAnchors(snapshot.lines)
    const lineEdits: Array<LineEdit> = []
    for (const [order, operation] of edits.entries()) {
      lineEdits.push(yield* toLineEdit(operation, anchors, path, order))
    }
    yield* rejectOverlappingEdits(lineEdits, path)

    const nextLines = [...snapshot.lines]
    for (const lineEdit of lineEdits.toSorted((left, right) => right.start - left.start || right.order - left.order)) {
      nextLines.splice(lineEdit.start, lineEdit.end - lineEdit.start, ...lineEdit.newLines)
    }

    const changedStart = Math.min(...lineEdits.map((lineEdit) => lineEdit.start)) + 1
    const changedEnd = Math.max(...lineEdits.map((lineEdit) => lineEdit.start + Math.max(lineEdit.newLines.length, 1)))
    return {
      text: renderSnapshotText(snapshot, nextLines),
      changedStartLine: changedStart,
      changedEndLine: Math.max(changedStart, changedEnd),
    }
  })

const toLineEdit = (operation: EditOperation, anchors: ReadonlyArray<Anchor>, path: string, order: number) =>
  Effect.gen(function* () {
    switch (operation.type) {
      case "set_line": {
        const start = yield* anchorIndex(operation.anchor, anchors, path)
        const newLines = yield* replacementLines(operation.new_text ?? "", path)
        return { start, end: start + 1, newLines, order }
      }
      case "replace_range": {
        const start = yield* anchorIndex(operation.anchor, anchors, path)
        const end = yield* anchorIndex(operation.end_anchor, anchors, path)
        if (end < start) return yield* invalidRange(path)
        const newLines = yield* replacementLines(operation.new_text ?? "", path)
        return { start, end: end + 1, newLines, order }
      }
      case "insert_before": {
        const start = yield* anchorIndex(operation.anchor, anchors, path)
        const newLines = yield* replacementLines(operation.new_text ?? "", path)
        return { start, end: start, newLines, order }
      }
      case "insert_after": {
        const start = (yield* anchorIndex(operation.anchor, anchors, path)) + 1
        const newLines = yield* replacementLines(operation.new_text ?? "", path)
        return { start, end: start, newLines, order }
      }
      case "delete_range": {
        const start = yield* anchorIndex(operation.anchor, anchors, path)
        const end = operation.end_anchor === undefined ? start : yield* anchorIndex(operation.end_anchor, anchors, path)
        if (end < start) return yield* invalidRange(path)
        return { start, end: end + 1, newLines: [], order }
      }
      case "replace_text":
        return yield* new HashlineFileError({
          message: "replace_text requires exact: true and cannot use anchors",
          code: "E_EXACT_REPLACE_REQUIRED",
          path,
          retryable: false,
        })
      default:
        return yield* Effect.die(new Error("Unknown hashline edit operation"))
    }
  })

const invalidRange = (path: string) =>
  new HashlineFileError({
    message: "end_anchor must be at or after anchor",
    code: "E_INVALID_RANGE",
    path,
    retryable: false,
  })

const replacementLines = (text: string, path: string) =>
  Effect.gen(function* () {
    yield* rejectPatchPrefixes(text, path)
    if (text.length === 0) return []
    const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
    if (normalized === "\n") return [""]
    const withoutFinalNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized
    return withoutFinalNewline.split("\n")
  })

const rejectPatchPrefixes = (text: string, path: string) => {
  for (const line of text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    if (displayAnchorPrefixPattern.test(line) || diffLineNumberPrefixPattern.test(line)) {
      return new HashlineFileError({
        message: "Replacement text must be literal file content, not hashline or diff-prefixed output",
        code: "E_INVALID_PATCH",
        path,
        retryable: false,
      })
    }
    if (bareHashPrefixPattern.test(line)) {
      return new HashlineFileError({
        message: "Replacement text must not start with a bare hashline prefix",
        code: "E_BARE_HASH_PREFIX",
        path,
        retryable: false,
      })
    }
  }
  return Effect.void
}

const anchorIndex = (anchor: string | undefined, anchors: ReadonlyArray<Anchor>, path: string) =>
  Effect.gen(function* () {
    if (anchor === undefined) {
      return yield* new HashlineFileError({
        message: "Anchored edits require an anchor",
        code: "E_MISSING_ANCHOR",
        path,
        retryable: false,
      })
    }
    const parsed = parseAnchor(anchor)
    if (parsed === undefined) {
      return yield* new HashlineFileError({
        message: `Invalid anchor ${anchor}. Expected LINE:HASH`,
        code: "E_INVALID_ANCHOR",
        path,
        retryable: false,
      })
    }
    const current = anchors[parsed.line - 1]
    if (current === undefined || current.hash !== parsed.hash) {
      const details: Common.JsonValue = {
        provided_anchor: anchor,
        fresh_anchors: anchorsNearLine(anchors, parsed.line).map(anchorToJson),
      }
      return yield* new HashlineFileError({
        message: `Stale anchor ${anchor}; read fresh anchors and retry`,
        code: "E_STALE_ANCHOR",
        path,
        retryable: true,
        details,
      })
    }
    return parsed.line - 1
  })

const rejectOverlappingEdits = (edits: ReadonlyArray<LineEdit>, path: string) => {
  const sorted = edits.toSorted((left, right) => left.start - right.start || left.end - right.end)
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]
    const current = sorted[index]
    if (previous !== undefined && current !== undefined && previous.end > current.start) {
      return new HashlineFileError({
        message: "Edit ranges overlap and cannot be applied safely",
        code: "E_OVERLAPPING_EDITS",
        path,
        retryable: false,
      })
    }
  }
  return Effect.void
}

const hasExactReplace = (edits: ReadonlyArray<EditOperation>) =>
  edits.some((operation) => operation.type === "replace_text")

const parseAnchor = (anchor: string) => {
  const match = anchorPattern.exec(anchor)
  if (match === null) return undefined
  const line = Number(match[1])
  const hash = match[2]
  if (!Number.isInteger(line) || line < 1 || hash === undefined) return undefined
  return { line, hash }
}

const buildAnchors = (lines: ReadonlyArray<string>): ReadonlyArray<Anchor> => {
  const occurrences = new Map<string, number>()
  const used = new Set<string>()
  return lines.map((content, index) => {
    const occurrence = occurrences.get(content) ?? 0
    occurrences.set(content, occurrence + 1)
    let salt = 0
    let hash = hashLine(content, index + 1, occurrence, salt)
    while (used.has(hash)) {
      salt += 1
      hash = hashLine(content, index + 1, occurrence, salt)
    }
    used.add(hash)
    const line = index + 1
    return { line, hash, anchor: `${line}:${hash}`, content }
  })
}

const hashLine = (content: string, line: number, occurrence: number, salt: number) =>
  createHash("sha256").update(`${line}\0${occurrence}\0${salt}\0${content}`).digest("base64url").slice(0, hashLength)

const formatAnchorLine = (anchor: Anchor) => `${anchor.anchor}|${anchor.content}`

const anchorToJson = (anchor: Anchor): Common.JsonValue => ({
  line: anchor.line,
  hash: anchor.hash,
  anchor: anchor.anchor,
  content: anchor.content,
})

const anchorsNearLine = (anchors: ReadonlyArray<Anchor>, line: number) =>
  anchors.slice(Math.max(0, line - 4), Math.min(anchors.length, line + 3))

const anchorsNearRange = (anchors: ReadonlyArray<Anchor>, startLine: number, endLine: number) =>
  anchors.slice(Math.max(0, startLine - 3), Math.min(anchors.length, endLine + 2))

const capAnchors = (anchors: ReadonlyArray<Anchor>, maxBytes: number) => {
  const encoder = new TextEncoder()
  const kept: Array<Anchor> = []
  let bytes = 0
  for (const anchor of anchors) {
    const nextBytes = encoder.encode(`${formatAnchorLine(anchor)}\n`).byteLength
    if (kept.length > 0 && bytes + nextBytes > maxBytes) return { anchors: kept, truncated: true }
    kept.push(anchor)
    bytes += nextBytes
  }
  return { anchors: kept, truncated: false }
}

const capReadAnchors = (anchors: ReadonlyArray<Anchor>, maxBytes: number) => {
  const encoder = new TextEncoder()
  const kept: Array<Anchor> = []
  let bytes = 0
  for (const anchor of anchors) {
    const lineSeparator = kept.length === 0 ? "" : "\n"
    const nextBytes = encoder.encode(`${lineSeparator}${formatAnchorLine(anchor)}`).byteLength
    if (bytes + nextBytes <= maxBytes) {
      kept.push(anchor)
      bytes += nextBytes
      continue
    }
    const remaining = maxBytes - bytes - encoder.encode(lineSeparator).byteLength
    if (remaining <= 0) return { anchors: kept, truncated: true }
    const prefix = `${anchor.anchor}|`
    const prefixBytes = encoder.encode(prefix).byteLength
    if (remaining < prefixBytes) return { anchors: kept, truncated: true }
    kept.push({ ...anchor, content: truncateUtf8(anchor.content, remaining - prefixBytes) })
    return { anchors: kept, truncated: true }
  }
  return { anchors: kept, truncated: false }
}

const truncateUtf8 = (text: string, maxBytes: number) => {
  if (maxBytes <= 0) return ""
  const encoder = new TextEncoder()
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (encoder.encode(text.slice(0, middle)).byteLength <= maxBytes) low = middle
    else high = middle - 1
  }
  return text.slice(0, low)
}

const detectLineEnding = (text: string): Snapshot["lineEnding"] => {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  const cr = (text.match(/\r(?!\n)/g) ?? []).length
  if (crlf === 0 && lf === 0 && cr === 0) return "none"
  if (crlf > 0 && lf === 0 && cr === 0) return "crlf"
  if (crlf === 0 && lf > 0 && cr === 0) return "lf"
  return "mixed"
}

const fileMetadata = (snapshot: Snapshot): Common.JsonValue => ({
  line_ending: snapshot.lineEnding,
  bom: snapshot.hasBom,
  final_newline: snapshot.finalNewline,
})

const pierreDiff = (path: string, before: string, after: string) =>
  jsonValue({
    kind: "diff",
    renderer: "@pierre/diffs",
    collapsed: true,
    file_diff: parseDiffFromFile(fileContents(path, before, "before"), fileContents(path, after, "after")),
  })

const fileContents = (path: string, contents: string, header: string): FileContents => ({
  name: path,
  contents,
  header,
  cacheKey: `${path}:${header}:${hashText(contents)}`,
})

const hashText = (text: string) => createHash("sha256").update(text).digest("base64url").slice(0, 12)

const atomicWrite = (path: string, content: string) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(path), { recursive: true }),
      catch: (cause) => writeError(path, cause),
    })
    const tempPath = `${path}.rika-${randomUUID()}.tmp`
    yield* Effect.tryPromise({
      try: async () => {
        await writeFile(tempPath, content)
        await rename(tempPath, path)
      },
      catch: (cause) => writeError(path, cause),
    }).pipe(Effect.tapError(() => Effect.promise(() => unlink(tempPath).catch(() => undefined))))
  })

const writeError = (path: string, cause: unknown) =>
  new HashlineFileError({
    message: cause instanceof Error ? cause.message : String(cause),
    code: "E_WRITE_FAILED",
    path,
    retryable: false,
  })

const isImagePath = (path: string) => /\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i.test(path)

const isLikelyBinary = (bytes: Uint8Array) => bytes.subarray(0, 8_000).includes(0)

const countOccurrences = (text: string, needle: string) => {
  if (needle.length === 0) return 0
  let count = 0
  let index = text.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = text.indexOf(needle, index + needle.length)
  }
  return count
}

const firstChangedLine = (before: string, after: string) => {
  const beforeLines = snapshotFromText(before).lines
  const afterLines = snapshotFromText(after).lines
  const length = Math.max(beforeLines.length, afterLines.length)
  for (let index = 0; index < length; index += 1) {
    if (beforeLines[index] !== afterLines[index]) return index + 1
  }
  return 1
}

const jsonValue = (value: unknown) =>
  Effect.gen(function* () {
    const normalized = yield* Effect.try({
      try: () => {
        const text = JSON.stringify(value)
        if (text === undefined) throw new Error("JSON.stringify returned undefined")
        return JSON.parse(text)
      },
      catch: (cause) =>
        new HashlineFileError({
          message: cause instanceof Error ? cause.message : "Tool output was not JSON serializable",
          code: "E_JSON_OUTPUT",
          retryable: false,
        }),
    })
    const decoded = Schema.decodeUnknownOption(Common.JsonValue)(normalized)
    if (Option.isSome(decoded)) return decoded.value
    return yield* new HashlineFileError({
      message: "Tool output was not JSON serializable",
      code: "E_JSON_OUTPUT",
      retryable: false,
    })
  })

const aliasField = (call: Call, from: string, to: string): Call => {
  const input = call.input
  if (typeof input !== "object" || input === null || Array.isArray(input)) return call
  const entries = Object.entries(input)
  const source = entries.find(([key]) => key === from)
  if (source === undefined || entries.some(([key]) => key === to)) return call
  const decoded = Schema.decodeUnknownOption(Common.JsonValue)(Object.fromEntries([...entries, [to, source[1]]]))
  if (Option.isNone(decoded)) return call
  return { ...call, input: decoded.value }
}

const withReadAliases = (call: Call): Call =>
  aliasField(aliasField(aliasField(call, "file", "path"), "line_start", "start_line"), "line_end", "end_line")

const decodeReadInput = (call: Call) => {
  const decoded = Schema.decodeUnknownOption(ReadInput)(withReadAliases(call).input)
  if (Option.isSome(decoded)) return Effect.succeed(decoded.value)
  return invalidToolInput(call.name)
}

const decodeWriteInput = (call: Call) => {
  const decoded = Schema.decodeUnknownOption(WriteInput)(call.input)
  if (Option.isSome(decoded)) return Effect.succeed(decoded.value)
  return invalidToolInput(call.name)
}

const decodeEditInput = (call: Call) => {
  const decoded = Schema.decodeUnknownOption(EditInput)(call.input)
  if (Option.isSome(decoded)) return Effect.succeed(decoded.value)
  return invalidToolInput(call.name)
}

const invalidToolInput = (name: string) =>
  new ToolRegistry.ToolRegistryError({
    message: `${name} input did not match the tool schema`,
    name,
    retryable: false,
  })

const toRegistryError = (name: string) => (error: HashlineFileError) =>
  new ToolRegistry.ToolRegistryError({
    message: error.message,
    name,
    retryable: error.retryable ?? false,
    details: {
      code: error.code,
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  })

const relativePath = (workspaceRoot: string, path: string) => relative(workspaceRoot, path) || "."
