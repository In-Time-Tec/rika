import * as ThreadToolkitsModule from "@rika/coding-tools/thread-tool-contract"
import * as ThreadReadModule from "@rika/coding-tools/thread-tool-contract"
import * as ThreadRepositoryModule from "@rika/product-store/sqlite-thread-repository"
import * as ThreadInteractionRepositoryModule from "@rika/product-store/sqlite-thread-interaction-repository"
import * as ThreadSearchRepositoryModule from "@rika/product-store/sqlite-thread-search-repository"
import * as ThreadModule from "@rika/product/thread-record"
import * as TurnRepositoryModule from "@rika/product-store/sqlite-turn-repository"
import * as TranscriptRepositoryModule from "@rika/product-store/sqlite-transcript-repository"
import * as TurnModule from "@rika/product/turn-record"
import * as TranscriptNestedProjectionModule from "@rika/transcript/nested-transcript-projection"
import * as TranscriptOrderingModule from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjectionModule from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModelModule from "@rika/transcript/transcript-projection-model"
import * as TranscriptUnitModule from "@rika/transcript/transcript-unit"
import * as ToolInvocationModule from "@rika/coding-tools/tool-invocation"

export namespace Fixtures {
  export import ThreadToolkits = ThreadToolkitsModule
  export import ThreadRead = ThreadReadModule
  export import ThreadRepository = ThreadRepositoryModule
  export import ThreadInteractionRepository = ThreadInteractionRepositoryModule
  export import ThreadSearchRepository = ThreadSearchRepositoryModule
  export import Thread = ThreadModule
  export import TurnRepository = TurnRepositoryModule
  export import TranscriptRepository = TranscriptRepositoryModule
  export import Turn = TurnModule
  export import TranscriptNestedProjection = TranscriptNestedProjectionModule
  export import TranscriptOrdering = TranscriptOrderingModule
  export import TranscriptProjection = TranscriptProjectionModule
  export import TranscriptProjectionModel = TranscriptProjectionModelModule
  export import TranscriptUnit = TranscriptUnitModule
  export import ToolInvocation = ToolInvocationModule
}
