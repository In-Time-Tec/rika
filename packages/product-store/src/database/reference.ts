import type { AnyPgColumn } from "drizzle-orm/pg-core"

const columns = new Map<string, AnyPgColumn>()

const register = (table: string, values: Readonly<Record<string, AnyPgColumn>>): void => {
  for (const [name, column] of Object.entries(values)) columns.set(`${table}.${name}`, column)
}

const column = (table: string, name: string): AnyPgColumn => {
  const value = columns.get(`${table}.${name}`)
  if (value === undefined) throw new Error(`Schema column ${table}.${name} has not been registered`)
  return value
}

export const SchemaReference = { column, register }
