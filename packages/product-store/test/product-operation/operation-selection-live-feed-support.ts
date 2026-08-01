import * as ExecutionIdentifier from "@rika/product/execution-identifier"
import * as ExecutionRequest from "@rika/product/execution-request"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { Effect } from "effect"
import { Service } from "@rika/product/product-operation-service"

export type TurnPromoter = ExecutionIdentifier.TurnPromoter
export type ThreadQueueWake = ExecutionRequest.ThreadQueueWake

export const testExecutionRoute = ExecutionRouteSnapshot.testExecutionRoute

export const operationService = Effect.service(Service)
