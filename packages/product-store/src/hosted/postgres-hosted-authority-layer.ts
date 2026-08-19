import * as PgClient from "@effect/sql-pg/PgClient"
import { Layer } from "effect"
import { layer as repositoryLayer } from "./postgres-hosted-authority-repository"

export const postgresLayer = (config: PgClient.PgPoolConfig) =>
  repositoryLayer.pipe(Layer.provideMerge(PgClient.layer(config)))
