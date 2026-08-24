import { Effect } from "effect"
import * as RuntimeTools from "./tools"
import { Service } from "./service"

export const handlerLayer = RuntimeTools.toolkit.toLayer(
  Effect.gen(function* () {
    const runtime = yield* Service
    return {
      grep: ({ pattern, regex, path }) =>
        runtime.run({ _tag: "Grep", pattern, regex, ...(path === undefined ? {} : { path }) }),
      list: ({ path, depth }) =>
        runtime.run({
          _tag: "List",
          ...(path === undefined ? {} : { path }),
          ...(depth === undefined ? {} : { depth }),
        }),
      read: ({ path, read_range }) =>
        runtime.run({ _tag: "Read", path, ...(read_range === undefined ? {} : { readRange: read_range }) }),
      write: ({ path, content }) => runtime.run({ _tag: "Write", path, content }),
      edit: ({ path, old_str, new_str, replace_all }) =>
        runtime.run({
          _tag: "Edit",
          path,
          oldStr: old_str,
          newStr: new_str,
          ...(replace_all === undefined ? {} : { replaceAll: replace_all }),
        }),
      bash: ({ command, workdir, timeout_ms }) =>
        runtime.run({
          _tag: "Bash",
          command,
          ...(workdir === undefined ? {} : { workdir }),
          ...(timeout_ms === undefined ? {} : { timeoutMillis: timeout_ms }),
        }),
      shell_command_status: ({ processId, waitMillis }) =>
        runtime.run({ _tag: "ShellCommandStatus", processId, ...(waitMillis == null ? {} : { waitMillis }) }),
      web_search: ({ objective, searchQueries, kind, strategy, githubSearchType }) =>
        runtime.run({
          _tag: "WebSearch",
          objective,
          searchQueries,
          ...(kind === undefined ? {} : { kind }),
          ...(strategy === undefined ? {} : { strategy }),
          ...(githubSearchType === undefined ? {} : { githubSearchType }),
        }),
      read_web_page: ({ url, objective, fullContent, forceRefetch }) =>
        runtime.run({
          _tag: "ReadWebPage",
          url,
          ...(objective === undefined ? {} : { objective }),
          ...(fullContent === undefined ? {} : { fullContent }),
          ...(forceRefetch === undefined ? {} : { forceRefetch }),
        }),
      view_media: ({ path }) => runtime.run({ _tag: "ViewMedia", path }),
    }
  }),
)
