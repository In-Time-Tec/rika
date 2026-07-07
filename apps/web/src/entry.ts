import { makeApplication as foldkitApplication } from "foldkit/runtime"
import { Layer } from "effect"
import { AppMessage, Model, init, subscriptions, update, type RuntimeConfig } from "./app"
import { orbTerminalRegistryLayer } from "./orb-terminal"
import { pierreTreeRegistryLayer } from "./pierre-tree"
import { view } from "./view"

export const webResourcesLayer = Layer.mergeAll(orbTerminalRegistryLayer, pierreTreeRegistryLayer)

export const makeApplication = (config: RuntimeConfig) =>
  foldkitApplication({
    Model,
    init: () => init(config),
    update,
    view,
    subscriptions,
    container: document.getElementById("root"),
    resources: webResourcesLayer,
    devTools: { Message: AppMessage },
  })
