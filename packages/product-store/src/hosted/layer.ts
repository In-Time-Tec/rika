import * as PgClient from "@effect/sql-pg/PgClient"
import { Layer } from "effect"
import { clientLayer } from "../database/postgres"
import { layer as assignmentLayer } from "./assignment-store/assignments"
import { layer as clientAuthorityLayer } from "./client-authority"
import { layer as threadEventStoreLayer } from "./thread-event-store"
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
    threadEventStoreLayer,
    environmentLayer,
    presenceLayer,
    productRepositoryLayer,
    runnerRegistrationsLayer,
    threadProtocolStoreLayer,
    workspacePreparationLayer,
  ).pipe(Layer.provideMerge(clientLayer(config)))
