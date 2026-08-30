import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Context, Effect, Layer } from "effect"
import type { HostedExecutionOperationsService } from "./operation-contract"

export class HostedExecutionOperations extends Context.Service<
  HostedExecutionOperations,
  HostedExecutionOperationsService
>()("@rika/product-store/hosted/execution/operations/HostedExecutionOperations") {}
import { operationsStore as dispatchOperations } from "./operation-dispatch"
import { operationsStore as lifecycleOperations } from "./operation-lifecycle"
import { operationsStore as finalizationOperations } from "./operation-finalization"
import { operationsStore as admissionOperations } from "./operation-admissions"

export * from "./operation-contract"

const make = Effect.gen(function* () {
  const db = yield* PgDrizzle.makeWithDefaults()
  return HostedExecutionOperations.of({
    ...dispatchOperations(db),
    ...lifecycleOperations(db),
    ...finalizationOperations(db),
    ...admissionOperations(db),
  })
})

export const layer = Layer.effect(HostedExecutionOperations, make)
