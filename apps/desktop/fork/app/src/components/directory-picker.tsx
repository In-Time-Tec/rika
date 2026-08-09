import { ServerConnection } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { directoryPickerKind } from "./directory-picker-policy"

type DirectoryPickerInput = {
  server: ServerConnection.Any
  title?: string
  multiple?: boolean
  onSelect: (result: string | string[] | null) => void
}

export function useDirectoryPicker() {
  const platform = usePlatform()

  return (input: DirectoryPickerInput) => {
    if (directoryPickerKind(platform.platform, input.server) !== "native" || platform.platform !== "desktop") {
      input.onSelect(null)
      return
    }
    void platform.openDirectoryPickerDialog({ title: input.title, multiple: input.multiple }).then(input.onSelect)
  }
}
