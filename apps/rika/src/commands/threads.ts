import * as Operation from "@rika/app/operation"
import { Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { dispatch } from "./shared"

const threadIdArgument = Argument.string("thread-id")
const nonEmptyStrings = Schema.decodeUnknownSync(Schema.NonEmptyArray(Schema.String))
const list = Command.make(
  "list",
  {
    includeArchived: Flag.boolean("include-archived"),
    limit: Flag.integer("limit").pipe(Flag.optional),
  },
  ({ includeArchived, limit }) => {
    const selectedLimit = Option.getOrUndefined(limit)
    return dispatch({
      _tag: "Thread",
      action: "list",
      ...(includeArchived ? { includeArchived } : {}),
      ...(selectedLimit === undefined ? {} : { limit: selectedLimit }),
    })
  },
)
const search = Command.make(
  "search",
  {
    includeArchived: Flag.boolean("include-archived"),
    limit: Flag.integer("limit").pipe(Flag.optional),
    query: Argument.string("query").pipe(Argument.variadic({ min: 1 })),
  },
  ({ includeArchived, limit, query }) => {
    const selectedLimit = Option.getOrUndefined(limit)
    return dispatch({
      _tag: "Thread",
      action: "search",
      query: nonEmptyStrings(query),
      ...(includeArchived ? { includeArchived } : {}),
      ...(selectedLimit === undefined ? {} : { limit: selectedLimit }),
    })
  },
)
const continueCommand = Command.make(
  "continue",
  {
    last: Flag.boolean("last"),
    threadIds: Argument.variadic(Argument.string("thread-id")),
  },
  ({ last, threadIds }) =>
    Effect.gen(function* () {
      if (last && threadIds.length > 0) {
        return yield* Operation.InvalidInput.make({
          message: "threads continue accepts --last or thread ids, not both",
        })
      }
      if (!last && threadIds.length === 0) {
        return yield* Operation.InvalidInput.make({
          message: "threads continue requires --last or at least one thread id",
        })
      }
      if (threadIds.length > 1) {
        return yield* Operation.InvalidInput.make({ message: "threads continue accepts exactly one thread id" })
      }
      if (last) {
        yield* dispatch({ _tag: "Interactive", prompt: [], last: true, ephemeral: false })
        return
      }
      yield* dispatch({ _tag: "Interactive", prompt: [], threadId: threadIds[0]!, ephemeral: false })
    }),
)
const fork = Command.make(
  "fork",
  {
    threadId: threadIdArgument,
    atTurn: Flag.string("at-turn").pipe(Flag.optional),
  },
  ({ threadId, atTurn }) => {
    const selectedTurn = Option.getOrUndefined(atTurn)
    return dispatch({
      _tag: "Thread",
      action: "fork",
      threadId,
      ...(selectedTurn === undefined ? {} : { atTurn: selectedTurn }),
    })
  },
)
const exportCommand = Command.make(
  "export",
  {
    threadId: threadIdArgument,
    format: Flag.choice("format", ["json", "markdown"]).pipe(Flag.withDefault("json")),
  },
  ({ threadId, format }) => dispatch({ _tag: "Thread", action: "export", threadId, format }),
)

export const command = Command.make("threads").pipe(
  Command.withDescription("Manage local durable threads"),
  Command.withSubcommands([
    Command.make("new", {}, () => dispatch({ _tag: "Thread", action: "new" })),
    continueCommand,
    list,
    search,
    Command.make("rename", { threadId: threadIdArgument, title: Argument.string("title") }, ({ threadId, title }) =>
      dispatch({ _tag: "Thread", action: "rename", threadId, title }),
    ),
    Command.make(
      "label",
      { threadId: threadIdArgument, labels: Argument.string("label").pipe(Argument.variadic({ min: 1 })) },
      ({ threadId, labels }) =>
        dispatch({ _tag: "Thread", action: "label", threadId, labels: nonEmptyStrings(labels) }),
    ),
    Command.make("pin", { threadId: threadIdArgument }, ({ threadId }) =>
      dispatch({ _tag: "Thread", action: "pin", threadId }),
    ),
    Command.make("archive", { threadId: threadIdArgument }, ({ threadId }) =>
      dispatch({ _tag: "Thread", action: "archive", threadId }),
    ),
    Command.make("unarchive", { threadId: threadIdArgument }, ({ threadId }) =>
      dispatch({ _tag: "Thread", action: "unarchive", threadId }),
    ),
    Command.make("delete", { threadId: threadIdArgument }, ({ threadId }) =>
      dispatch({ _tag: "Thread", action: "delete", threadId }),
    ),
    Command.make("usage", { threadId: threadIdArgument }, ({ threadId }) =>
      dispatch({ _tag: "Thread", action: "usage", threadId }),
    ),
    fork,
    exportCommand,
  ]),
)
