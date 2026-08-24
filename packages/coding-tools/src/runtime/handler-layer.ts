import { Effect } from "effect"
import * as RuntimeTools from "./tools"
import { Service } from "./service"
import { Inputs } from "./inputs"

export const handlerLayer = RuntimeTools.toolkit.toLayer(
  Effect.gen(function* () {
    const runtime = yield* Service
    return {
      grep: ({ pattern, regex, path }) => {
        const request =
          path === undefined
            ? Inputs.Grep.Request.make({ _tag: "Grep", pattern, regex })
            : Inputs.Grep.Request.make({ _tag: "Grep", pattern, regex, path })
        return runtime.run(request)
      },
      list: ({ path, depth }) => {
        let request = Inputs.List.Request.make({ _tag: "List" })
        if (path !== undefined) request = Inputs.List.Request.make({ ...request, path })
        if (depth !== undefined) request = Inputs.List.Request.make({ ...request, depth })
        return runtime.run(request)
      },
      read: ({ path, read_range }) => {
        const request =
          read_range === undefined
            ? Inputs.Read.Request.make({ _tag: "Read", path })
            : Inputs.Read.Request.make({ _tag: "Read", path, readRange: read_range })
        return runtime.run(request)
      },
      write: ({ path, content }) => runtime.run({ _tag: "Write", path, content }),
      edit: ({ path, old_str, new_str, replace_all }) => {
        const base = Inputs.Edit.Request.make({ _tag: "Edit", path, oldStr: old_str, newStr: new_str })
        const request =
          replace_all === undefined
            ? Inputs.Edit.Request.make(base)
            : Inputs.Edit.Request.make({ ...base, replaceAll: replace_all })
        return runtime.run(request)
      },
      bash: ({ command, workdir, timeout_ms }) => {
        let request = Inputs.Bash.Request.make({ _tag: "Bash", command })
        if (workdir !== undefined) request = Inputs.Bash.Request.make({ ...request, workdir })
        if (timeout_ms !== undefined) request = Inputs.Bash.Request.make({ ...request, timeoutMillis: timeout_ms })
        return runtime.run(request)
      },
      shell_command_status: ({ processId, waitMillis }) => {
        const request =
          waitMillis == null
            ? Inputs.ShellStatus.Request.make({ _tag: "ShellCommandStatus", processId })
            : Inputs.ShellStatus.Request.make({ _tag: "ShellCommandStatus", processId, waitMillis })
        return runtime.run(request)
      },
      web_search: ({ objective, searchQueries, kind, strategy, githubSearchType }) => {
        let request = Inputs.WebSearch.Request.make({ _tag: "WebSearch", objective, searchQueries })
        if (kind !== undefined) request = Inputs.WebSearch.Request.make({ ...request, kind })
        if (strategy !== undefined) request = Inputs.WebSearch.Request.make({ ...request, strategy })
        if (githubSearchType !== undefined) request = Inputs.WebSearch.Request.make({ ...request, githubSearchType })
        return runtime.run(request)
      },
      read_web_page: ({ url, objective, fullContent, forceRefetch }) => {
        let request = Inputs.ReadPage.Request.make({ _tag: "ReadWebPage", url })
        if (objective !== undefined) request = Inputs.ReadPage.Request.make({ ...request, objective })
        if (fullContent !== undefined) request = Inputs.ReadPage.Request.make({ ...request, fullContent })
        if (forceRefetch !== undefined) request = Inputs.ReadPage.Request.make({ ...request, forceRefetch })
        return runtime.run(request)
      },
      view_media: ({ path }) => runtime.run({ _tag: "ViewMedia", path }),
    }
  }),
)
