import type { Tool } from "effect/unstable/ai"
import type { Client, Ids } from "@relayfx/sdk"
import type { LayerOptions } from "./relay-execution-adapter"
import type { childExecutionDepth } from "../../agent-depth"

export interface ChildExecutionMethodsInput<AdditionalTools extends Record<string, Tool.Any>> {
  readonly client: Client.Interface
  readonly options: Pick<
    LayerOptions<AdditionalTools>,
    | "additionalToolkit"
    | "selection"
    | "oracleSelection"
    | "compactionSummarySelection"
    | "modelVariantPolicy"
    | "compaction"
    | "oracleCompaction"
  >
  readonly context: {
    readonly addressId: Ids.AddressId
    readonly childExecutionDepth: typeof childExecutionDepth
    readonly toolsAtDepth: (tools: ReadonlyArray<string>, depth: number) => ReadonlyArray<string>
  }
}
