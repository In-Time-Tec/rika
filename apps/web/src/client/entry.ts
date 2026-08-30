import { makeApplication, run } from "foldkit/runtime"
import {
  Model,
  init,
  subscriptions,
  update,
  view,
  type Message as MessageValue,
  type Model as ModelValue,
} from "./main"
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
