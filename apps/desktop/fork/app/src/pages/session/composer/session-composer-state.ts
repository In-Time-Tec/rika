import { createMemo, createSignal } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { useParams } from "@solidjs/router"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { sessionPermissionRequest } from "./session-request-tree"

export function createSessionComposerController() {
  const params = useParams()
  const sdk = useSDK()
  const sync = useSync()
  const language = useLanguage()

  const permissionRequest = createMemo((): PermissionRequest | undefined =>
    sessionPermissionRequest(sync().data.session, sync().data.permission, params.id),
  )

  const blocked = createMemo(() => !!params.id && !!permissionRequest())
  const [responding, setResponding] = createSignal<string | undefined>()
  const permissionResponding = createMemo(() => responding() === permissionRequest()?.id)

  const decide = (response: "once" | "reject") => {
    const perm = permissionRequest()
    if (!perm || responding() === perm.id) return
    setResponding(perm.id)
    sdk()
      .api.permission.reply({ sessionID: perm.sessionID, requestID: perm.id, reply: response })
      .catch((err: unknown) => {
        const description = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description })
      })
      .finally(() => setResponding((id) => (id === perm.id ? undefined : id)))
  }

  return {
    blocked,
    permissionRequest,
    permissionResponding,
    decide,
  }
}

export type SessionComposerController = ReturnType<typeof createSessionComposerController>
