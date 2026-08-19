import { Schema } from "effect"
export const Operation = Schema.Literals(["initialize", "fileSearch", "glob", "grep"])
export type Operation = typeof Operation.Type
