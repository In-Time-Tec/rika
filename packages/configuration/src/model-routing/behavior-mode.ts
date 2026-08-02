import { Schema } from "effect"

export const modeIds = ["low", "medium", "high", "ultra"] as const

export const ModeId = Schema.Literals(modeIds)
export type ModeId = typeof ModeId.Type

export const routeModeIds = [...modeIds, "test"] as const

export const RouteModeId = Schema.Literals(routeModeIds)
export type RouteModeId = typeof RouteModeId.Type
