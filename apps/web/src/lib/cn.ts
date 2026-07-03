export type ClassValue = string | false | null | undefined

export const cn = (...values: ReadonlyArray<ClassValue>): string =>
  values.filter((value): value is string => typeof value === "string" && value.length > 0).join(" ")
