import { Effect, Schema } from "effect"
import { Command, Flag } from "effect/unstable/cli"

export interface Options {
  readonly command: "plan" | "setup" | "run" | "compare"
  readonly output: string
  readonly candidateBatonRelease?: string
  readonly samples: number
  readonly baselineTag: "v0.5.3"
  readonly baselineBatonVersion: "0.20.2"
  readonly baseline?: string
  readonly candidate?: string
}

export type Handler<E = never, R = never> = (options: Options) => Effect.Effect<void, E, R>

const samples = Flag.integer("samples").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(3))),
  Flag.withDefault(3),
)
const output = Flag.string("output")
const baseline = { baselineTag: "v0.5.3", baselineBatonVersion: "0.20.2" } as const

export const makeCommand = <E, R>(handler: Handler<E, R>) =>
  Command.make("semantic-output-benchmark").pipe(
    Command.withSubcommands([
      Command.make("plan", { output, samples }, (options) => handler({ command: "plan", ...options, ...baseline })),
      Command.make(
        "setup",
        { output, samples, candidateBatonRelease: Flag.string("candidate-baton-release") },
        (options) => handler({ command: "setup", ...options, ...baseline }),
      ),
      Command.make(
        "run",
        { output, samples, candidateBatonRelease: Flag.string("candidate-baton-release") },
        (options) => handler({ command: "run", ...options, ...baseline }),
      ),
      Command.make(
        "compare",
        {
          output,
          samples,
          baseline: Flag.string("baseline"),
          candidate: Flag.string("candidate"),
        },
        (options) => handler({ command: "compare", ...options, ...baseline }),
      ),
    ]),
  )
