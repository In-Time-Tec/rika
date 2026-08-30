import * as PgClient from "@effect/sql-pg/PgClient"
import { Layer } from "effect"
import { TypeOverrides, types } from "pg"
import { layer as assignmentLayer } from "./assignment-store/assignments"
import { layer as clientAuthorityLayer } from "./client-authority"
import { layer as threadEventStoreLayer } from "./thread-event-store"
import { layer as environmentLayer } from "./environment-store"
import { layer as presenceLayer } from "./presence"
import { layer as productRepositoryLayer } from "./product/repository"
import { layer as runnerRegistrationsLayer } from "./runner/registrations"
import { layer as threadProtocolStoreLayer } from "./thread-protocol-store"
import { layer as workspacePreparationLayer } from "./workspace-preparations"

const postgresTypes = new TypeOverrides()
postgresTypes.setTypeParser(types.builtins.INT8, (value) => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed))
    throw new RangeError(`PostgreSQL BIGINT is outside JavaScript's safe integer range: ${value}`)
  return parsed
})

export const layer = (config: PgClient.PgPoolConfig) =>
  Layer.mergeAll(
    assignmentLayer,
    clientAuthorityLayer,
    threadEventStoreLayer,
    environmentLayer,
    presenceLayer,
    productRepositoryLayer,
    runnerRegistrationsLayer,
    threadProtocolStoreLayer,
    workspacePreparationLayer,
  ).pipe(Layer.provideMerge(PgClient.layer({ ...config, types: postgresTypes })))
