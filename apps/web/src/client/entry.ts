import { makeApplication, run } from "foldkit/runtime"
import { Model, init, subscriptions, update, view } from "./main"
import type { Message as MessageValue, Model as ModelValue } from "./main"
import "./styles.css"

const application = makeApplication<ModelValue, MessageValue>({
  Model,
  init,
  update,
  view,
  subscriptions,
  container: document.getElementById("root"),
})

run(application)
