import * as ThreadModule from "@rika/product/thread-record"
import * as TranscriptRepositoryModule from "@rika/product-store/sqlite-transcript-repository"
import * as TurnModule from "@rika/product/turn-record"
import * as TranscriptPageModule from "@rika/product/transcript-page"
import * as TurnRepositoryModule from "@rika/product-store/sqlite-turn-repository"
import * as UsageRepositoryModule from "@rika/product-store/sqlite-usage-repository"
import * as ExecutionBackendModule from "@rika/product/execution-service"
import * as ExecutionEventModule from "@rika/product/execution-event"
import * as ExecutionStatusModule from "@rika/product/execution-status"
import * as ThreadResultModule from "@rika/product/thread-result"
import * as TranscriptCorrelationModule from "@rika/transcript/child-parent-correlation"
import * as TranscriptNestedProjectionModule from "@rika/transcript/nested-transcript-projection"
import * as TranscriptOrderingModule from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjectionModule from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModelModule from "@rika/transcript/transcript-projection-model"
import * as TranscriptUsageModule from "@rika/transcript/model-usage-fallback"
import * as UsageCostModule from "@rika/product/usage-projection"
export namespace Fixtures {
  export import Thread = ThreadModule
  export import TranscriptRepository = TranscriptRepositoryModule
  export import Turn = TurnModule
  export import TranscriptPage = TranscriptPageModule
  export import TurnRepository = TurnRepositoryModule
  export import UsageRepository = UsageRepositoryModule
  export import ExecutionBackend = ExecutionBackendModule
  export import ExecutionEvent = ExecutionEventModule
  export import ExecutionStatus = ExecutionStatusModule
  export import ThreadResult = ThreadResultModule
  export import TranscriptCorrelation = TranscriptCorrelationModule
  export import TranscriptNestedProjection = TranscriptNestedProjectionModule
  export import TranscriptOrdering = TranscriptOrderingModule
  export import TranscriptProjection = TranscriptProjectionModule
  export import TranscriptProjectionModel = TranscriptProjectionModelModule
  export import TranscriptUsage = TranscriptUsageModule
  export import UsageCost = UsageCostModule
}
