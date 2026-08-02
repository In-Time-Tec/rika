import { Schema } from "effect"
import { Report, NoReport, Failed, Cancelled } from "./agent-tool-result"

export const Result = Schema.Union([Report, NoReport, Failed, Cancelled])
export type Result = typeof Result.Type
export const AwaitSubagentsResult = Schema.Struct({ subagents: Schema.Array(Result) })
export type AwaitSubagentsResult = typeof AwaitSubagentsResult.Type
