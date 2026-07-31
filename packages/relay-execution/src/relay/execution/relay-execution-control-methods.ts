import { Client } from "@relayfx/sdk"
import { historyMethods } from "./relay-execution-history-methods"
import { lifecycleMethods } from "./relay-execution-lifecycle-methods"
import { toolMethods } from "./relay-execution-tool-methods"

export const controlMethods = (client: Client.Interface) =>
  Object.assign(historyMethods(client), lifecycleMethods(client), toolMethods(client))
