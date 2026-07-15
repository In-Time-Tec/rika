import { Effect, FileSystem, Path, Schema } from "effect"
import { unifiedDiff } from "./unified-diff"

export const Input = Schema.Struct({ patchText: Schema.String })
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
  diff: Schema.optionalKey(Schema.String),
})
export type Output = typeof Output.Type

export class ApplyPatchError extends Schema.TaggedErrorClass<ApplyPatchError>()("ApplyPatchError", {
  message: Schema.String,
}) {}

type Hunk = { readonly lines: ReadonlyArray<string> }
type Operation =
  | { readonly kind: "add"; readonly path: string; readonly content: string }
  | { readonly kind: "delete"; readonly path: string }
  | { readonly kind: "update"; readonly path: string; readonly moveTo?: string; readonly hunks: ReadonlyArray<Hunk> }

const fail = (message: string): never => {
  throw new Error(message)
}

export const parse = (patchText: string): ReadonlyArray<Operation> => {
  const lines = patchText.split("\n")
  if (lines.at(-1) === "") lines.pop()
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") fail("malformed patch envelope")
  const operations: Array<Operation> = []
  while (lines.length > 0) {
    const header = lines.shift()!
    const match = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(header)
    if (match === null) fail(`malformed operation header: ${header}`)
    const kind = match![1]
    const filePath = match![2]!
    if (kind === "Add") {
      const content: Array<string> = []
      while (lines.length > 0 && lines[0]?.startsWith("*** ") !== true) {
        const line = lines.shift()!
        if (!line.startsWith("+")) fail("add file lines must start with +")
        content.push(line.slice(1))
      }
      operations.push({ kind: "add", path: filePath, content: content.join("\n") + (content.length > 0 ? "\n" : "") })
      continue
    }
    if (kind === "Delete") {
      operations.push({ kind: "delete", path: filePath })
      continue
    }
    let moveTo: string | undefined
    if (lines[0]?.startsWith("*** Move to: ") === true) moveTo = lines.shift()?.slice(13)
    const hunks: Array<Hunk> = []
    while (lines.length > 0 && lines[0]?.startsWith("*** ") !== true) {
      const hunkHeader = lines.shift()!
      if (!hunkHeader.startsWith("@@")) fail(`expected hunk header, got: ${hunkHeader}`)
      const hunkLines: Array<string> = []
      while (
        lines.length > 0 &&
        lines[0]?.startsWith("@@") !== true &&
        !/^\*\*\* (?:Add|Delete|Update) File: /.test(lines[0]!)
      ) {
        const line = lines.shift()!
        if (line !== "*** End of File" && !/^[ +-]/u.test(line)) fail(`malformed hunk line: ${line}`)
        if (line !== "*** End of File") hunkLines.push(line)
      }
      if (hunkLines.length === 0) fail("empty hunk")
      hunks.push({ lines: hunkLines })
    }
    if (hunks.length === 0 && moveTo === undefined) fail("update requires a hunk or move")
    operations.push({ kind: "update", path: filePath, ...(moveTo === undefined ? {} : { moveTo }), hunks })
  }
  if (operations.length === 0) fail("patch has no operations")
  return operations
}

const replaceHunk = (content: string, hunk: Hunk): string => {
  const before = hunk.lines.filter((line) => line[0] !== "+").map((line) => line.slice(1))
  const after = hunk.lines.filter((line) => line[0] !== "-").map((line) => line.slice(1))
  if (before.length === 0) fail("insert-only hunks require context")
  const lines = content.split("\n")
  const matches: Array<number> = []
  for (let index = 0; index <= lines.length - before.length; index += 1) {
    if (before.every((line, offset) => lines[index + offset] === line)) matches.push(index)
  }
  if (matches.length === 0) fail("stale patch context")
  if (matches.length > 1) fail("ambiguous patch context")
  const first = matches[0]!
  return [...lines.slice(0, first), ...after, ...lines.slice(first + before.length)].join("\n")
}

const contained = (workspace: string, value: string, path: Path.Path): string => {
  const absolute = path.resolve(workspace, value)
  const relative = path.relative(workspace, absolute)
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    fail(`path escapes workspace: ${value}`)
  return absolute
}

export const apply = Effect.fn("ApplyPatch.apply")(function* (
  workspace: string,
  patchText: string,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
) {
  const operations = yield* Effect.try({
    try: () => parse(patchText),
    catch: (cause) => ApplyPatchError.make({ message: String(cause) }),
  })
  const staged = new Map<string, string | null>()
  const originals = new Map<string, string | null>()
  const relativePath = new Map<string, string>()
  const load = (target: string) =>
    staged.has(target)
      ? Effect.succeed(staged.get(target) ?? null)
      : fileSystem
          .exists(target)
          .pipe(
            Effect.flatMap((exists) =>
              exists
                ? fileSystem.readFileString(target).pipe(Effect.map((value) => value as string | null))
                : Effect.succeed(null),
            ),
          )
  yield* Effect.gen(function* () {
    for (const operation of operations) {
      const source = contained(workspace, operation.path, path)
      const current = yield* load(source)
      if (!originals.has(source)) originals.set(source, current)
      relativePath.set(source, operation.path)
      if (operation.kind === "add") {
        if (current !== null) fail(`${operation.path} already exists`)
        staged.set(source, operation.content)
      } else if (operation.kind === "delete") {
        if (current === null) fail(`${operation.path} does not exist`)
        staged.set(source, null)
      } else {
        if (current === null) fail(`${operation.path} does not exist`)
        let next = current!
        for (const hunk of operation.hunks) next = replaceHunk(next, hunk)
        if (operation.moveTo === undefined) staged.set(source, next)
        else {
          const destination = contained(workspace, operation.moveTo, path)
          if ((yield* load(destination)) !== null) fail(`${operation.moveTo} already exists`)
          if (!originals.has(destination)) originals.set(destination, null)
          relativePath.set(destination, operation.moveTo)
          staged.set(source, null)
          staged.set(destination, next)
        }
      }
    }
  }).pipe(
    Effect.sandbox,
    Effect.mapError((cause) => ApplyPatchError.make({ message: String(cause) })),
  )
  for (const [target, content] of staged) {
    if (content === null) {
      if (yield* fileSystem.exists(target)) yield* fileSystem.remove(target)
    } else {
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true })
      yield* fileSystem.writeFileString(target, content)
    }
  }
  const patches: Array<string> = []
  for (const [target, content] of staged) {
    const before = originals.get(target) ?? null
    const rendered = unifiedDiff(relativePath.get(target) ?? target, before ?? "", content ?? "", before === null)
    if (rendered !== undefined) patches.push(rendered)
  }
  const diff = patches.join("\n")
  return {
    text: `applied ${operations.length} operation${operations.length === 1 ? "" : "s"}`,
    truncated: false,
    ...(diff.length === 0 || diff.length > 100_000 ? {} : { diff }),
  }
})
