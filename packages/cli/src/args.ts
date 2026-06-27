import { Config } from "@rika/core"
import { Ids } from "@rika/schema"
import { Effect, Option, Schema } from "effect"

export interface ExecuteCommand extends Schema.Schema.Type<typeof ExecuteCommand> {}
export const ExecuteCommand = Schema.Struct({
  type: Schema.Literal("execute"),
  prompt: Schema.String,
  mode: Schema.optional(Config.Mode),
  workspace_root: Schema.optional(Schema.String),
  thread_id: Schema.optional(Ids.ThreadId),
  ephemeral: Schema.Boolean,
}).annotate({ identifier: "Rika.Cli.Args.ExecuteCommand" })

export type Command = ExecuteCommand

export class ArgsError extends Schema.TaggedErrorClass<ArgsError>()("ArgsError", {
  message: Schema.String,
  exit_code: Schema.Int,
  usage: Schema.optional(Schema.String),
}) {}

export const usage = [
  "Usage:",
  "  rika run [options] <prompt>",
  "  rika --execute [options] <prompt>",
  "",
  "Options:",
  "  -e, --execute           Run one non-interactive turn",
  "  --mode <rush|smart|deep> Select agent mode",
  "  --workspace <path>      Workspace root for the turn",
  "  --thread <id>           Reuse a durable thread id",
  "  --ephemeral            Use in-memory persistence for this run",
  "  -h, --help             Show this help",
].join("\n")

export const parse = Effect.fn("Cli.Args.parse")(function* (argv: ReadonlyArray<string>) {
  if (argv.length === 0) return yield* usageError()
  if (argv.includes("--help") || argv.includes("-h")) return yield* helpError()

  const args = argv[0] === "run" ? argv.slice(1) : argv[0] === "--execute" || argv[0] === "-e" ? argv.slice(1) : argv
  if (args.length === argv.length && argv[0] !== "--execute" && argv[0] !== "-e") return yield* usageError()

  const parsed = yield* parseExecuteArgs(args)
  if (parsed.prompt.length === 0) return yield* usageError("Missing prompt")
  return parsed
})

const parseExecuteArgs = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    let mode: Config.Mode | undefined
    let workspaceRoot: string | undefined
    let threadId: Ids.ThreadId | undefined
    let ephemeral = false
    const promptParts: Array<string> = []

    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index]
      if (arg === undefined) continue
      switch (arg) {
        case "--mode":
          mode = yield* valueAfter(argv, index, arg).pipe(Effect.flatMap(parseMode))
          index += 1
          break
        case "--workspace":
          workspaceRoot = yield* valueAfter(argv, index, arg)
          index += 1
          break
        case "--thread":
          threadId = Ids.ThreadId.make(yield* valueAfter(argv, index, arg))
          index += 1
          break
        case "--ephemeral":
          ephemeral = true
          break
        default:
          if (arg.startsWith("-")) return yield* usageError(`Unknown option ${arg}`)
          promptParts.push(arg)
          break
      }
    }

    const command: ExecuteCommand = {
      type: "execute",
      prompt: promptParts.join(" ").trim(),
      ephemeral,
      ...(mode === undefined ? {} : { mode }),
      ...(workspaceRoot === undefined ? {} : { workspace_root: workspaceRoot }),
      ...(threadId === undefined ? {} : { thread_id: threadId }),
    }
    return command
  })

const valueAfter = (argv: ReadonlyArray<string>, index: number, name: string) => {
  const value = argv[index + 1]
  if (value === undefined || value.length === 0) return usageError(`Missing value for ${name}`)
  return Effect.succeed(value)
}

const parseMode = (value: string) => {
  const decoded = Schema.decodeUnknownOption(Config.Mode)(value)
  if (Option.isSome(decoded)) return Effect.succeed(decoded.value)
  return usageError(`Invalid mode ${value}`)
}

const usageError = (message = "Expected run or --execute") => new ArgsError({ message, exit_code: 2, usage })

const helpError = () => new ArgsError({ message: usage, exit_code: 0 })
