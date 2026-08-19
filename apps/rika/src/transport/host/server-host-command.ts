import { Formatter } from "effect"

export const formatOutput = (values: ReadonlyArray<unknown>): string =>
  `${values.map((value) => (typeof value === "string" ? value : Formatter.format(value))).join(" ")}\n`
