import * as BunServices from "@effect/platform-bun/BunServices"
import * as LocalTools from "@rika/execution/local-tools"
import { Layer } from "effect"

export const tuiToolRuntimeLayer = (workspace: string) =>
  LocalTools.layer(workspace).pipe(Layer.provide(BunServices.layer))
