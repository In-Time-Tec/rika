import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { layer } from "./local-host"

Layer.launch(layer()).pipe(NodeRuntime.runMain)
