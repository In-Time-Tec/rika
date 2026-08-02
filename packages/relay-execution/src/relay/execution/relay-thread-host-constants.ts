import { ModelRegistry } from "@batonfx/core"
import { Ids } from "@relayfx/sdk"

export const hostAgentId = Ids.AgentId.make("agent:rika-thread-host")
export const entityKind = Ids.ResidentKindName.make("rika-thread")
export const continueAsNewAfterTurns = 32
export const hostMaxWaitTurns = 1_000_000
export const hostSelection: ModelRegistry.ModelSelection = { provider: "rika", model: "thread-host" }
export const waitToolName = "wait_for_messages"
