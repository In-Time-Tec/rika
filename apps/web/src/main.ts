import { Ids } from "@rika/schema"
import { run } from "foldkit/runtime"
import { makeApplication } from "./entry"
import "./styles.css"

const env = (import.meta as ImportMeta & { readonly env?: Record<string, string | undefined> }).env
const params = new URLSearchParams(window.location.search)
const rawThreadId = params.get("thread") ?? params.get("thread_id") ?? undefined
const thread_id = rawThreadId === undefined ? undefined : Ids.ThreadId.make(rawThreadId)
const api_base_url = env?.VITE_RIKA_API_BASE_URL ?? "/api/rika"

run(makeApplication({ api_base_url, ...(thread_id === undefined ? {} : { thread_id }) }))
