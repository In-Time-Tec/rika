import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import * as SettingsDecoder from "@rika/configuration/configuration-settings"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionRequest from "@rika/product/execution-request"
import * as ThreadResult from "@rika/product/thread-result"
import { queuedTurnPromoteMaxAgeMs } from "@rika/product/pending-turn"

export const Repositories = {
  ExecutionBackend,
  ExecutionRequest,
  ExecutionRouteSnapshot,
  SettingsDefaults,
  SettingsDecoder,
  Thread,
  ThreadRepository,
  ThreadResult,
  Turn,
  TurnRepository,
  queuedTurnPromoteMaxAgeMs,
}
