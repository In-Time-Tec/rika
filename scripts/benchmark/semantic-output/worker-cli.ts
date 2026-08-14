import { Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import type { Case, Source } from "./contract"
import { cases } from "./contract"

export interface WorkerOptions {
  readonly source: Source
  readonly case: Case
  readonly sample: number
  readonly warmup: boolean
  readonly root: string
  readonly identity: string
}

export type WorkerHandler<E = never, R = never> = (options: WorkerOptions) => Effect.Effect<void, E, R>

export const makeWorkerCommand = <E, R>(handler: WorkerHandler<E, R>) =>
  Command.make(
    "semantic-output-worker",
    {
      source: Flag.choice("source", ["baseline", "candidate"]),
      case: Flag.choice("case", cases),
      sample: Flag.integer("sample"),
      warmup: Flag.choiceWithValue("warmup", [
        ["true", true],
        ["false", false],
      ]),
      root: Flag.string("root"),
      identity: Flag.string("identity"),
    },
    handler,
  )
