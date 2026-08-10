import { Effect, Schema } from "effect"
import type { HostBindingRegistry } from "@batonfx/repl"
import * as CodingToolResult from "@rika/coding-tools/coding-tool-result"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import { maximumDepth } from "@rika/coding-tools/list-files-tool"
import { nested, NestedOperationFailed, operation, type Requirements } from "./nested-operation-envelope"

export const name = "workspace"

const Failure = Schema.Union([CodingToolResult.ToolFailure, NestedOperationFailed])

const Read = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
})

const Searched = Schema.Struct({
  text: Schema.String,
  matches: Schema.Array(CodingToolResult.WorkspaceSearchMatch),
  matchesTruncation: Schema.optionalKey(CodingToolResult.WorkspaceSearchMatchesTruncation),
  truncated: Schema.Boolean,
})

const Listed = Schema.Struct({
  text: Schema.String,
  entries: Schema.Array(CodingToolResult.WorkspaceListEntry),
  truncated: Schema.Boolean,
})

const Edited = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
  diff: Schema.optionalKey(Schema.String),
})

const SearchInput = Schema.Struct({
  pattern: Schema.String,
  regex: Schema.optionalKey(Schema.Boolean),
  path: Schema.optionalKey(Schema.String),
})
const ListInput = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
  depth: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maximumDepth))),
})
const ReadInput = Schema.Struct({
  path: Schema.String,
  range: Schema.optionalKey(Schema.Array(Schema.Int).check(Schema.isLengthBetween(2, 2))),
})
const WriteInput = Schema.Struct({ path: Schema.String, content: Schema.String })
const ReplaceInput = Schema.Struct({
  path: Schema.String,
  oldStr: Schema.String,
  newStr: Schema.String,
  replaceAll: Schema.optionalKey(Schema.Boolean),
})

const run = (request: typeof CodingToolRuntime.Request.Type) =>
  Effect.flatMap(CodingToolRuntime.Service, (runtime) => runtime.run(request))

const read = (result: CodingToolResult.Result) => ({ text: result.text, truncated: result.truncated })

const searched = (result: CodingToolResult.Result) => ({
  text: result.text,
  matches: result.matches ?? [],
  ...(result.matchesTruncation === undefined ? {} : { matchesTruncation: result.matchesTruncation }),
  truncated: result.truncated,
})

const listed = (result: CodingToolResult.Result) => ({
  text: result.text,
  entries: result.entries ?? [],
  truncated: result.truncated,
})

const edited = (result: CodingToolResult.Result) => ({
  text: result.text,
  truncated: result.truncated,
  ...(result.diff === undefined ? {} : { diff: result.diff }),
})

export const operations: ReadonlyArray<HostBindingRegistry.AnyOperation<CodingToolRuntime.Service | Requirements>> = [
  operation({
    name: "search",
    input: SearchInput,
    output: Searched,
    failure: Failure,
    handle: (input) =>
      Effect.map(
        run({
          _tag: "Grep",
          pattern: input.pattern,
          regex: input.regex ?? false,
          ...(input.path === undefined ? {} : { path: input.path }),
        }),
        searched,
      ),
  }),
  operation({
    name: "list",
    input: ListInput,
    output: Listed,
    failure: Failure,
    handle: (input) =>
      Effect.map(
        run({
          _tag: "List",
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.depth === undefined ? {} : { depth: input.depth }),
        }),
        listed,
      ),
  }),
  operation({
    name: "read",
    input: ReadInput,
    output: Read,
    failure: Failure,
    handle: (input) =>
      Effect.map(
        run({ _tag: "Read", path: input.path, ...(input.range === undefined ? {} : { readRange: input.range }) }),
        read,
      ),
  }),
  operation({
    name: "write",
    input: WriteInput,
    output: Edited,
    failure: Failure,
    handle: (input) =>
      nested(
        {
          kind: "workspace.write",
          payload: input,
          replayPolicy: "never",
          approval: { capability: "workspace.write", request: { path: input.path } },
        },
        Effect.map(run({ _tag: "Write", path: input.path, content: input.content }), edited),
      ),
  }),
  operation({
    name: "replace",
    input: ReplaceInput,
    output: Edited,
    failure: Failure,
    handle: (input) =>
      nested(
        {
          kind: "workspace.replace",
          payload: input,
          replayPolicy: "never",
          approval: { capability: "workspace.replace", request: { path: input.path } },
        },
        Effect.map(
          run({
            _tag: "Edit",
            path: input.path,
            oldStr: input.oldStr,
            newStr: input.newStr,
            ...(input.replaceAll === undefined ? {} : { replaceAll: input.replaceAll }),
          }),
          edited,
        ),
      ),
  }),
]

export const module: HostBindingRegistry.Module<CodingToolRuntime.Service | Requirements> = { name, operations }
