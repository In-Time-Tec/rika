import * as ThreadRepositoryModule from "@rika/product-store/sqlite-thread-repository"
import * as ThreadModule from "@rika/product/thread-record"
import * as TranscriptRepositoryModule from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepositoryModule from "@rika/product-store/sqlite-turn-repository"
import * as UsageRepositoryModule from "@rika/product-store/sqlite-usage-repository"
import * as SummaryRepositoryModule from "@rika/product-store/sqlite-thread-summary-repository"
import * as TurnModule from "@rika/product/turn-record"
import * as ExecutionBackendModule from "@rika/product/execution-service"
import * as ExecutionEventModule from "@rika/product/execution-event"
import * as ExecutionStatusModule from "@rika/product/execution-status"
import * as ThreadResultModule from "@rika/product/thread-result"
import * as ToolRuntimeModule from "@rika/coding-tools/coding-tool-runtime"

export namespace Fixtures {
  export import ThreadRepository = ThreadRepositoryModule
  export import Thread = ThreadModule
  export import TranscriptRepository = TranscriptRepositoryModule
  export import TurnRepository = TurnRepositoryModule
  export import UsageRepository = UsageRepositoryModule
  export import SummaryRepository = SummaryRepositoryModule
  export import Turn = TurnModule
  export import ExecutionBackend = ExecutionBackendModule
  export import ExecutionEvent = ExecutionEventModule
  export import ExecutionStatus = ExecutionStatusModule
  export import ThreadResult = ThreadResultModule
  export import ToolRuntime = ToolRuntimeModule
}
