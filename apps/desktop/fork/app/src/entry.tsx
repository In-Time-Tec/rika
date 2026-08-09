// @refresh reload

import * as Sentry from "@sentry/solid"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { loadInitialLocale } from "@/context/language"
import { type Platform, PlatformProvider } from "@/context/platform"
import { createBrowserDraftStore } from "@/utils/draft-store"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import pkg from "../package.json"
import { ServerConnection } from "./context/server"

const RIKA_SERVER_KEY = ServerConnection.Key.make("rika")

const getLocale = () => {
  if (typeof navigator !== "object") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }
  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()
  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const notify: Platform["notify"] = async (title, description, onClick) => {
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  const notification = new Notification(title, {
    body: description ?? "",
    icon: "/favicon-96x96.png",
  })

  notification.onclick = () => {
    window.focus()
    onClick?.()
    notification.close()
  }
}

const openExternal: Platform["openExternal"] = (value) => {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return
  window.open(url.href, "_blank", "noopener,noreferrer")
}

const restart: Platform["restart"] = async () => {
  window.location.reload()
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const getRikaServerUrl = () => {
  const configured = import.meta.env.VITE_RIKA_SERVER_URL?.trim()
  if (configured) return configured.replace(/\/+$/, "")

  const url = new URL(location.href)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = "/server"
  url.search = ""
  url.hash = ""
  return url.toString()
}

const readRikaConnection = () => {
  const params = new URLSearchParams(location.search)
  const token = import.meta.env.VITE_RIKA_SERVER_TOKEN?.trim() || params.get("rika_token")?.trim()
  if (!token) {
    throw new Error(
      "Rika web connections require VITE_RIKA_SERVER_TOKEN or a rika_token URL parameter. Configure the server before loading the app.",
    )
  }
  const identity =
    import.meta.env.VITE_RIKA_SERVER_IDENTITY?.trim() || params.get("rika_identity")?.trim() || "rika-web"
  if (params.has("rika_token") || params.has("rika_identity")) {
    params.delete("rika_token")
    params.delete("rika_identity")
    history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`)
  }
  return {
    url: getRikaServerUrl(),
    token,
    identity,
  }
}

const platform: Platform = {
  platform: "web",
  draftStore: createBrowserDraftStore(),
  version: pkg.version,
  openExternal,
  restart,
  notify,
}

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `web@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "web",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" && !(import.meta.env.OPENCODE_CHANNEL === "prod" && i.name === "GlobalHandlers"),
      )
    },
  })
}

if (root instanceof HTMLElement) {
  void loadInitialLocale().then((locale) => {
    const input = readRikaConnection()
    const server: ServerConnection.Rika = {
      type: "rika",
      http: { url: input.url },
      rika: input,
    }
    render(
      () => (
        <PlatformProvider value={platform}>
          <AppBaseProviders locale={locale}>
            <AppInterface defaultServer={RIKA_SERVER_KEY} canonicalLocalServer={RIKA_SERVER_KEY} servers={[server]} />
          </AppBaseProviders>
        </PlatformProvider>
      ),
      root,
    )
  })
}
