import { makeApplication as foldkitApplication } from "foldkit/runtime"
import { AppMessage, Model, init, subscriptions, update, type RuntimeConfig } from "./app"
import { view } from "./view"

export const makeApplication = (config: RuntimeConfig) =>
  foldkitApplication({
    Model,
    init: () => init(config),
    update,
    view,
    subscriptions,
    container: document.getElementById("root"),
    devTools: { Message: AppMessage },
  })
