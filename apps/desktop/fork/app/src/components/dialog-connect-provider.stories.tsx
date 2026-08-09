import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { onMount } from "solid-js"
import { DialogConnectProvider } from "./dialog-connect-provider"

function OpenRouterConnectionStory() {
  const dialog = useDialog()
  const open = () => dialog.show(() => <DialogConnectProvider />)
  onMount(open)
  return (
    <Button variant="secondary" onClick={open}>
      Connect OpenRouter
    </Button>
  )
}

export default {
  title: "App/Dialogs/Connect OpenRouter",
  id: "app-dialog-connect-openrouter",
}

export const ApiKey = { render: () => <OpenRouterConnectionStory /> }
