import { Array as Arr } from "effect"

export const uniqueNonEmptyStrings = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  Arr.dedupe(Arr.filter(values, (value) => value.length > 0))
