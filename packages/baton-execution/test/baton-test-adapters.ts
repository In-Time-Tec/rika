import { Effect } from "effect"
import type { ConfigureOptions } from "../src/baton-route-options"
import { configure as configureRoute } from "../src/baton-route"
import { layerSqliteTest, remoteCellAdapter, type SqliteTestOptions } from "../src/baton-execution"
import * as RemoteCellDispatcher from "../src/remote-cell-dispatcher"

export const remoteCell = remoteCellAdapter({
  dispatcher: RemoteCellDispatcher.layer({
    dispatchDeduplicated: () =>
      RemoteCellDispatcher.DispatchUnavailable.make({ message: "test dispatcher is unavailable" }),
  }),
  maxRetries: 0,
  retryDelayMillis: 1,
})

export const configure = (options: Omit<ConfigureOptions, "cell">): ReturnType<typeof configureRoute> =>
  configureRoute({ ...options, cell: remoteCell })

export const sqliteLayer = (options: Omit<SqliteTestOptions, "cell">) =>
  layerSqliteTest({ ...options, cell: remoteCell })

export const successfulRemoteCell = (result: unknown) =>
  remoteCellAdapter({
    dispatcher: RemoteCellDispatcher.layer({
      dispatchDeduplicated: () => Effect.succeed({ _tag: "Success", result }),
    }),
    maxRetries: 0,
    retryDelayMillis: 1,
  })
