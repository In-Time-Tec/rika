import { Schema } from "effect"
import { Turn, TurnId } from "../turn/record"

export const PageCursor = Schema.Struct({ createdAt: Schema.Finite, id: TurnId })
export interface PageCursor extends Schema.Schema.Type<typeof PageCursor> {}

export interface PageOptions {
  readonly before?: PageCursor | undefined
  readonly limit?: number
}

export interface PageResult {
  readonly turns: ReadonlyArray<Turn>
  readonly hasOlder: boolean
  readonly oldestCursor: PageCursor | undefined
  readonly newestCursor: PageCursor | undefined
}

export const defaultPageSize = 50
export const maximumPageSize = 200
