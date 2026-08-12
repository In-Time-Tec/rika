import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import type * as Runtime from "@batonfx/runtime"
import { Stream } from "effect"

export interface PreviewRuntime {
  readonly previews: (input: { readonly runId: string }) => Stream.Stream<Runtime.ModelPreview.Event>
}

export const modelPreviewEvent = (event: Runtime.ModelPreview.Event): ExecutionGateway.ModelPreviewEvent => event

export const merge = <E>(input: {
  readonly projections: Stream.Stream<ExecutionProjection.Change, E>
  readonly previews: Stream.Stream<Runtime.ModelPreview.Event>
}): Stream.Stream<ExecutionGateway.WatchEvent, E> =>
  Stream.merge(input.projections, Stream.map(input.previews, modelPreviewEvent), { haltStrategy: "left" })
