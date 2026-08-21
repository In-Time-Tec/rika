import * as PgClient from "@effect/sql-pg/PgClient"
import { Layer } from "effect"
import { layer as assignmentLayer } from "./postgres-assignments"
import { layer as storeLayer } from "./postgres-store"
import { layer as threadProtocolStoreLayer } from "./postgres-thread-protocol-store"

export const layer = (config: PgClient.PgPoolConfig) =>
  Layer.mergeAll(storeLayer, assignmentLayer, threadProtocolStoreLayer).pipe(Layer.provideMerge(PgClient.layer(config)))
