import { Effect } from "effect"
import { configure as configureRoute, type ConfigureOptions } from "../../src/routing/route"
import { layerMemory, remoteTools, type MemoryOptions } from "../../src/engine/runtime"
import * as RemoteTools from "../../src/remote-tools"

export const remoteTool = remoteTools({
  tools: RemoteTools.layer({
    execute: () => RemoteTools.Unavailable.make({ message: "test remote tools are unavailable" }),
    cancel: () => RemoteTools.Unavailable.make({ message: "test remote tools are unavailable" }),
  }),
  admit: () => Effect.void,
})

export const configure = (options: ConfigureOptions): ReturnType<typeof configureRoute> => configureRoute(options)

export const memoryLayer = (options: MemoryOptions): ReturnType<typeof layerMemory> => layerMemory(options)
