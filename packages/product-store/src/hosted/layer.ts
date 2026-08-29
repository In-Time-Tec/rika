import * as PgClient from "@effect/sql-pg/PgClient"
import { Layer } from "effect"
import { layer as assignmentLayer } from "./assignments"
import { layer as clientAuthorityLayer } from "./client-authority"
import { layer as commandLedgerLayer } from "./command-ledger"
import { layer as environmentLayer } from "./environment-store"
import { layer as presenceLayer } from "./presence"
import { layer as productRepositoryLayer } from "./product/repository"
import { layer as runnerRegistrationsLayer } from "./runner/registrations"
import { layer as threadProtocolStoreLayer } from "./thread-protocol-store"
import { layer as workspacePreparationLayer } from "./workspace-preparations"

export const layer = (config: PgClient.PgPoolConfig) =>
  Layer.mergeAll(
    assignmentLayer,
    clientAuthorityLayer,
    commandLedgerLayer,
    environmentLayer,
    presenceLayer,
    productRepositoryLayer,
    runnerRegistrationsLayer,
    threadProtocolStoreLayer,
    workspacePreparationLayer,
  ).pipe(Layer.provideMerge(PgClient.layer(config)))
