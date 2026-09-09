import * as PgClient from "@effect/sql-pg/PgClient"
import { Context, Effect, Layer } from "effect"
import type { ProductRepositoryService } from "./contract"
import { projectOperations } from "./project-operations"
import { metadataOperations } from "./metadata-operations"
import { threadOperations } from "./thread-operations"
import { workspaceOperations } from "./workspace-operations"

export * from "./contract"

export class ProductRepository extends Context.Service<ProductRepository, ProductRepositoryService>()(
  "@rika/product-store/hosted/product/repository/ProductRepository",
) {}

const make = Effect.gen(function* () {
  yield* PgClient.PgClient
  const workspace = yield* workspaceOperations
  const project = yield* projectOperations
  const metadata = yield* metadataOperations
  const thread = yield* threadOperations
  return ProductRepository.of({ ...workspace, ...project, ...metadata, ...thread })
})

export const layer = Layer.effect(ProductRepository, make)
