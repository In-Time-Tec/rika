import * as PgClient from "@effect/sql-pg/PgClient"
import { Layer } from "effect"
import { layer as assignmentLayer } from "./postgres-assignments"
import { layer as storeLayer } from "./postgres-store"

export const layer = (config: PgClient.PgPoolConfig) =>
  Layer.merge(storeLayer, assignmentLayer).pipe(Layer.provideMerge(PgClient.layer(config)))
