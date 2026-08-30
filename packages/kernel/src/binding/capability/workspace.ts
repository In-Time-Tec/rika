import { Effect, Schema } from "effect"
import type { HostBindingRegistry } from "tenetkit/repl"
import * as CodingToolResult from "@rika/coding-tools/coding-tool-result"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import { maximumDepth } from "@rika/coding-tools/list-files-tool"
import { nested, NestedOperationFailed, operation, type Requirements } from "../envelope"

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

const run = (request: CodingToolRuntime.Request) =>
  Effect.flatMap(CodingToolRuntime.Service, (runtime) => runtime.run(request))

const read = (result: CodingToolResult.Result) => ({ text: result.text, truncated: result.truncated })

const searched = (result: CodingToolResult.Result) => {
  let value: typeof Searched.Type = {
    text: result.text,
    matches: result.matches ?? [],
    truncated: result.truncated,
  }
  if (result.matchesTruncation !== undefined) value = { ...value, matchesTruncation: result.matchesTruncation }
  return value
}

const listed = (result: CodingToolResult.Result) => ({
  text: result.text,
  entries: result.entries ?? [],
  truncated: result.truncated,
})

const edited = (result: CodingToolResult.Result) => {
  const value: typeof Edited.Type = { text: result.text, truncated: result.truncated }
  return result.diff === undefined ? value : { ...value, diff: result.diff }
}

export const operations: ReadonlyArray<HostBindingRegistry.AnyOperation<CodingToolRuntime.Service | Requirements>> = [
  operation({
    name: "search",
    input: SearchInput,
    output: Searched,
    failure: Failure,
    handle: (input) =>
      Effect.map(
        run(
          input.path === undefined
            ? { _tag: "Grep", pattern: input.pattern, regex: input.regex ?? false }
            : { _tag: "Grep", pattern: input.pattern, regex: input.regex ?? false, path: input.path },
        ),
        searched,
      ),
  }),
  operation({
    name: "list",
    input: ListInput,
    output: Listed,
    failure: Failure,
    handle: (input) => {
      let request: CodingToolRuntime.Request = { _tag: "List" }
      if (input.path !== undefined) request = { ...request, path: input.path }
      if (input.depth !== undefined) request = { ...request, depth: input.depth }
      return Effect.map(run(request), listed)
    },
  }),
  operation({
    name: "read",
    input: ReadInput,
    output: Read,
    failure: Failure,
    handle: (input) =>
      Effect.map(
        run(
          input.range === undefined
            ? { _tag: "Read", path: input.path }
            : { _tag: "Read", path: input.path, readRange: input.range },
        ),
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
          run(
            input.replaceAll === undefined
              ? { _tag: "Edit", path: input.path, oldStr: input.oldStr, newStr: input.newStr }
              : {
                  _tag: "Edit",
                  path: input.path,
                  oldStr: input.oldStr,
                  newStr: input.newStr,
                  replaceAll: input.replaceAll,
                },
          ),
          edited,
        ),
      ),
  }),
]

export const module: HostBindingRegistry.Module<CodingToolRuntime.Service | Requirements> = { name, operations }
