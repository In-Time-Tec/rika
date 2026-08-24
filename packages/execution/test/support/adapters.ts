import { Effect } from "effect"
import { configure as configureRoute, type ConfigureOptions } from "../../src/route"
import { layerMemory, remoteCells, type MemoryOptions } from "../../src/runtime"
import * as RemoteCells from "../../src/remote-cells"

export const remoteCell = remoteCells({
  cells: RemoteCells.layer({
    execute: () => RemoteCells.Unavailable.make({ message: "test remote cells are unavailable" }),
  }),
  admit: () => Effect.void,
})

export const configure = (options: Omit<ConfigureOptions, "cell">): ReturnType<typeof configureRoute> =>
  configureRoute({ ...options, cell: remoteCell })

export const memoryLayer = (options: Omit<MemoryOptions, "cells">) => layerMemory({ ...options, cells: remoteCell })

export const successfulRemoteCell = (result: unknown) =>
  remoteCells({
    cells: RemoteCells.layer({
      execute: () => Effect.succeed({ _tag: "Success", result }),
    }),
    admit: () => Effect.void,
  })
