import * as ContextFileSystem from "@rika/product/context-file-system"
import * as ResolvedContext from "@rika/product/context-resolution-service"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Layer } from "effect"

export const layer = (workspaceGlob: typeof import("./server-configuration-adapter").workspaceGlob) =>
  ResolvedContext.layer(workspaceGlob).pipe(
    Layer.provide(ContextFileSystem.liveLayer),
    Layer.provide(BunServices.layer),
  )
