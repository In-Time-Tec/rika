import * as BunServices from "@effect/platform-bun/BunServices"
import type * as PgClient from "@effect/sql-pg/PgClient"
import { HarnessStore } from "tenetkit/harness"
import * as ArtifactStore from "@rika/kernel/artifact-store"
import * as HarnessStoreLocations from "@rika/kernel/harness-store-locations"
import * as GoalService from "@rika/product/goal-service"
import type { OwnerId } from "@rika/product/hosted-model"
import * as ThreadQuery from "@rika/product/thread-query-service"
import * as ProductRepositories from "@rika/product-store/product-repositories"
import * as ThreadSearchIndex from "@rika/product-store/thread-search-index"
import { Layer } from "effect"

export type Services =
  | ThreadQuery.Factory
  | HarnessStore.HarnessStore
  | GoalService.GoalService
  | ArtifactStore.ArtifactStore

export const layer = ({
  ownerId,
  dataRoot,
}: {
  readonly ownerId: OwnerId
  readonly dataRoot: string
}): Layer.Layer<Services, never, PgClient.PgClient> => {
  const root = `${dataRoot}/bindings/${encodeURIComponent(String(ownerId))}`
  const repositories = Layer.merge(ProductRepositories.layer(ownerId), ThreadSearchIndex.layer)
  const services = Layer.mergeAll(
    ThreadQuery.Runtime.factoryLayer,
    HarnessStoreLocations.layer({
      home: `${root}/home`,
      workspace: `${root}/workspace`,
      dataRoot: `${root}/data`,
    }),
    GoalService.layer,
    ArtifactStore.layer(`${root}/data`),
  )
  return services.pipe(Layer.provide(repositories), Layer.provide(BunServices.layer))
}
