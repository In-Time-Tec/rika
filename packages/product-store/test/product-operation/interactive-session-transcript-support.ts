import * as TranscriptCorrelationModule from "@rika/transcript/child-parent-correlation"
import * as TranscriptIdentityModule from "@rika/transcript/transcript-unit-identity"
import * as TranscriptNestedProjectionModule from "@rika/transcript/nested-transcript-projection"
import * as TranscriptOrderingModule from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjectionModule from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModelModule from "@rika/transcript/transcript-projection-model"
import * as TranscriptUnitModule from "@rika/transcript/transcript-unit"
import * as TranscriptUsageModule from "@rika/transcript/model-usage-fallback"
import * as UsageCostModule from "@rika/product/usage-projection"

export namespace Fixtures {
  export import TranscriptCorrelation = TranscriptCorrelationModule
  export import TranscriptIdentity = TranscriptIdentityModule
  export import TranscriptNestedProjection = TranscriptNestedProjectionModule
  export import TranscriptOrdering = TranscriptOrderingModule
  export import TranscriptProjection = TranscriptProjectionModule
  export import TranscriptProjectionModel = TranscriptProjectionModelModule
  export import TranscriptUnit = TranscriptUnitModule
  export import TranscriptUsage = TranscriptUsageModule
  export import UsageCost = UsageCostModule
}
