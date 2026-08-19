import { Effect } from "effect"
import { configure as configureRoute, type ConfigureOptions } from "../src/route"
import { layerLocal, remoteCells, type LocalOptions } from "../src/runtime"
import * as RemoteCells from "../src/remote-cells"

export const remoteCell = remoteCells({
  cells: RemoteCells.layer({
    execute: () => RemoteCells.Unavailable.make({ message: "test remote cells are unavailable" }),
  }),
  maxRetries: 0,
  retryDelayMillis: 1,
})

export const configure = (options: Omit<ConfigureOptions, "cell">): ReturnType<typeof configureRoute> =>
  configureRoute({ ...options, cell: remoteCell })

export const sqliteLayer = (options: Omit<LocalOptions, "cells">) => layerLocal({ ...options, cells: remoteCell })

export const successfulRemoteCell = (result: unknown) =>
  remoteCells({
    cells: RemoteCells.layer({
      execute: () => Effect.succeed({ _tag: "Success", result }),
    }),
    maxRetries: 0,
    retryDelayMillis: 1,
  })
