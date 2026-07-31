import { Effect } from "effect"
import { dataRoot } from "@rika/config/data-root"
import prompt from "./prompt.prompt.txt"

export const spikeEffect = Effect.succeed(`${dataRoot}:${prompt}`)
