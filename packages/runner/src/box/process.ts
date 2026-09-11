import { currentExecutorPolicy } from "@rika/product/executor-policy"

import { runBoxExecutorProcess, type BoxExecutorMainOptions } from "./main"

const connectBoxExecutorWebSocket: BoxExecutorMainOptions["connect"] = (url, protocol, headers) =>
  new globalThis.WebSocket(url, { protocols: [protocol], headers })

export const boxExecutorProcessOptions: BoxExecutorMainOptions = {
  expected: currentExecutorPolicy,
  connect: connectBoxExecutorWebSocket,
}

if (import.meta.main) runBoxExecutorProcess(boxExecutorProcessOptions)
