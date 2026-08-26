import * as ThreadToolkitsModule from "@rika/coding-tools/thread-tool-contract"
import * as ThreadReadModule from "@rika/coding-tools/thread-tool-contract"
import * as ThreadRepositoryModule from "@rika/product-store/thread-repository"
import * as ThreadSearchRepositoryModule from "@rika/product-store/memory-thread-search-repository"
import * as ThreadModule from "@rika/product/thread-record"
import * as TurnRepositoryModule from "@rika/product-store/turn-repository"
import * as TranscriptRepositoryModule from "@rika/product-store/transcript-repository"
import * as TurnModule from "@rika/product/turn-record"
import * as ExecutionRouteSnapshotModule from "@rika/product/execution-route-snapshot"
import * as TranscriptOrderingModule from "@rika/transcript/transcript-unit-order"
import * as TranscriptUnitModule from "@rika/transcript/transcript-unit"

export namespace Fixtures {
  export import ThreadToolkits = ThreadToolkitsModule
  export import ThreadRead = ThreadReadModule
  export import ThreadRepository = ThreadRepositoryModule
  export import ThreadSearchRepository = ThreadSearchRepositoryModule
  export import Thread = ThreadModule
  export import TurnRepository = TurnRepositoryModule
  export import TranscriptRepository = TranscriptRepositoryModule
  export import Turn = TurnModule
  export import ExecutionRouteSnapshot = ExecutionRouteSnapshotModule
  export import TranscriptOrdering = TranscriptOrderingModule
  export import TranscriptUnit = TranscriptUnitModule
}
