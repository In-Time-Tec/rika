import * as ExecutionStatus from "@rika/product/execution-status"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { executionRoute } from "../../../product-store/test/support/product-test-current-state"
import {
  storeProjection,
  withNestedProjections,
} from "../../../product-store/test/support/product-test-transcript-fixture"
import { productLayer, provideLayer } from "../../../product-store/test/support/operation-layer-harness"
import {
  collectEvents,
  holdSession,
  openInteractiveSession,
  settleEvents,
} from "../../../product-store/test/support/operation-session-harness"
import { executionStarted, backend } from "../../../product-store/test/support/operation-execution-fixtures"
import { turnProvenance, selectionThread } from "../../../product-store/test/support/operation-selection-fixtures"

export const Fixtures = {
  ExecutionStatus,
  ThreadRepository,
  Thread,
  TranscriptRepository,
  TurnRepository,
  Turn,
  ExecutionBackend,
  ExecutionEvent,
  TranscriptCorrelation,
  TranscriptProjection,
  executionRoute,
  storeProjection,
  withNestedProjections,
  productLayer,
  provideLayer,
  collectEvents,
  holdSession,
  openInteractiveSession,
  settleEvents,
  executionStarted,
  backend,
  turnProvenance,
  selectionThread,
}
