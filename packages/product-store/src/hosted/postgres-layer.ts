import * as PgClient from "@effect/sql-pg/PgClient"
import { Layer } from "effect"
import { layer as assignmentLayer } from "./postgres-assignments"
import { layer as environmentLayer } from "./postgres-environment-store"
import { layer as storeLayer } from "./postgres-store"
import { layer as threadProtocolStoreLayer } from "./postgres-thread-protocol-store"
import { layer as workspacePreparationLayer } from "./postgres-workspace-preparations"

export const layer = (config: PgClient.PgPoolConfig) =>
  Layer.mergeAll(
    storeLayer,
    assignmentLayer,
    environmentLayer,
    threadProtocolStoreLayer,
    workspacePreparationLayer,
  ).pipe(Layer.provideMerge(PgClient.layer(config)))
