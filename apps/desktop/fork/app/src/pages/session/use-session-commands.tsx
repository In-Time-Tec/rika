import { useNavigate } from "@solidjs/router"
import { useCommand, type CommandOption } from "@/context/command"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"
import { UserMessage } from "@opencode-ai/sdk/v2"

export type SessionCommandContext = {
  navigateMessageByOffset: (offset: number) => void
  setActiveMessage: (message: UserMessage | undefined) => void
  focusInput: () => void
}

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

export const useSessionCommands = (actions: SessionCommandContext) => {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const settings = useSettings()
  const sync = useSync()
  const navigate = useNavigate()
  const { params } = useSessionLayout()

  const fork = () => {
    void import("@/components/dialog-fork").then((x) => dialog.show(() => <x.DialogFork />))
  }

  const sessionCommand = withCategory(language.t("command.category.session"))
  const viewCommand = withCategory(language.t("command.category.view"))

  const userMessages = () => {
    const id = params.id
    if (!id) return []
    return (sync().data.message[id] ?? []).filter((message) => message.role === "user") as UserMessage[]
  }

  const sessionCmds = () => [
    sessionCommand({
      id: "session.new",
      title: language.t("command.session.new"),
      keybind: "mod+shift+s",
      slash: "new",
      onSelect: (source) => {
        if (settings.general.newLayoutDesigns()) {
          command.trigger("tab.new", source)
          return
        }
        navigate(`/${params.dir}/session`)
      },
    }),
    sessionCommand({
      id: "session.fork",
      title: language.t("command.session.fork"),
      description: language.t("command.session.fork.description"),
      slash: "fork",
      disabled: !params.id || userMessages().length === 0,
      onSelect: fork,
    }),
  ]

  const messageCmds = () => [
    sessionCommand({
      id: "message.previous",
      title: language.t("command.message.previous"),
      description: language.t("command.message.previous.description"),
      keybind: "mod+alt+[",
      disabled: !params.id,
      onSelect: () => actions.navigateMessageByOffset(-1),
    }),
    sessionCommand({
      id: "message.next",
      title: language.t("command.message.next"),
      description: language.t("command.message.next.description"),
      keybind: "mod+alt+]",
      disabled: !params.id,
      onSelect: () => actions.navigateMessageByOffset(1),
    }),
  ]

  const viewCmds = () => [
    viewCommand({
      id: "input.focus",
      title: language.t("command.input.focus"),
      keybind: "ctrl+l",
      onSelect: actions.focusInput,
    }),
  ]

  command.register("session", () => [...sessionCmds(), ...messageCmds(), ...viewCmds()])
}
