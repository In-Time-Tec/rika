import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { TextField } from "@opencode-ai/ui/text-field"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogBody, DialogHeader, DialogTitle, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useParams } from "@solidjs/router"
import { createUniqueId, onMount, Show, type Accessor, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useSettings } from "@/context/settings"
import { decode64 } from "@/utils/base64"
import { showToast } from "@/utils/toast"

const OPENROUTER_ID = "openrouter"
const OPENROUTER_NAME = "OpenRouter"

export function useProviderConnectController(options: { onBack?: () => void } = {}) {
  return {
    selected: () => OPENROUTER_ID,
    select: (_provider?: string) => undefined,
    back: options.onBack ?? (() => undefined),
  }
}

export const DialogConnectProvider: Component<{
  directory?: Accessor<string | undefined>
  controller?: ReturnType<typeof useProviderConnectController>
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const settings = useSettings()
  const params = useParams()
  const newLayout = settings.general.newLayoutDesigns
  const directory = () => props.directory?.() ?? decode64(params.dir)
  const location = () => {
    const value = directory()
    return value ? { directory: value } : undefined
  }
  const errorID = createUniqueId()
  const [form, setForm] = createStore({
    value: "",
    pending: false,
    error: undefined as string | undefined,
  })
  let apiKey: HTMLInputElement | undefined

  onMount(() => {
    if (!newLayout()) return
    apiKey?.focus({ preventScroll: true })
  })

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const value = form.value.trim()
    if (!value) {
      setForm("error", language.t("provider.connect.apiKey.required"))
      return
    }

    setForm({ pending: true, error: undefined })
    try {
      await serverSDK().api.integration.connect.key({
        integrationID: OPENROUTER_ID,
        location: location(),
        key: value,
      })
      await serverSync()
        .refreshProviders()
        .catch(() => undefined)
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.connect.toast.connected.title", { provider: OPENROUTER_NAME }),
        description: language.t("provider.connect.toast.connected.description", { provider: OPENROUTER_NAME }),
      })
    } catch (error) {
      setForm("error", error instanceof Error ? error.message : String(error))
    } finally {
      setForm("pending", false)
    }
  }

  const Form = () =>
    newLayout() ? (
      <div class="flex flex-col gap-5 px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted">
        <div>{language.t("provider.connect.apiKey.description", { provider: OPENROUTER_NAME })}</div>
        <form onSubmit={submit} class="flex flex-col items-start gap-5 self-stretch">
          <label class="flex w-full flex-col gap-1 font-[530] leading-4 text-v2-text-text-base">
            {language.t("provider.connect.apiKey.label", { provider: OPENROUTER_NAME })}
            <TextInputV2
              ref={apiKey}
              class="!w-full"
              name="apiKey"
              data-input="provider-api-key"
              placeholder={language.t("provider.connect.apiKey.placeholder")}
              value={form.value}
              invalid={form.error !== undefined}
              aria-describedby={form.error ? errorID : undefined}
              autocomplete="off"
              spellcheck={false}
              disabled={form.pending}
              onInput={(event) => setForm("value", event.currentTarget.value)}
            />
          </label>
          <Show when={form.error}>
            {(error) => (
              <div id={errorID} role="alert" class="-mt-4 text-xs text-v2-state-fg-danger">
                {error()}
              </div>
            )}
          </Show>
          <ButtonV2 type="submit" variant="contrast" data-action="provider-connect-submit" disabled={form.pending}>
            {language.t("common.continue")}
          </ButtonV2>
        </form>
      </div>
    ) : (
      <div class="flex flex-col gap-6 px-2.5 pb-10">
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.apiKey.description", { provider: OPENROUTER_NAME })}
        </div>
        <form onSubmit={submit} class="flex flex-col items-start gap-4">
          <TextField
            autofocus
            ref={apiKey}
            type="text"
            label={language.t("provider.connect.apiKey.label", { provider: OPENROUTER_NAME })}
            placeholder={language.t("provider.connect.apiKey.placeholder")}
            name="apiKey"
            value={form.value}
            onChange={(value) => setForm("value", value)}
            validationState={form.error ? "invalid" : undefined}
            error={form.error}
            disabled={form.pending}
          />
          <Button class="w-auto" type="submit" size="large" variant="primary" disabled={form.pending}>
            {language.t("common.continue")}
          </Button>
        </form>
      </div>
    )

  const Content = () => (
    <div class={newLayout() ? "flex min-h-0 flex-1 flex-col" : "flex flex-col gap-6 px-2.5 pb-3"}>
      <div class={newLayout() ? "flex h-10 shrink-0 items-start gap-2 px-3" : "flex items-center gap-4 px-2.5"}>
        <ProviderIcon
          id={OPENROUTER_ID}
          class={newLayout() ? "mt-0.5 size-4 shrink-0 text-v2-icon-icon-base" : "size-5 shrink-0 icon-strong-base"}
        />
        <div
          class={
            newLayout()
              ? "text-[15px] font-[530] leading-5 tracking-[-0.13px] text-v2-text-text-base"
              : "text-16-medium text-text-strong"
          }
        >
          {language.t("provider.connect.title", { provider: OPENROUTER_NAME })}
        </div>
      </div>
      <Form />
    </div>
  )

  return (
    <Show
      when={newLayout()}
      fallback={
        <Dialog class="h-full" transition title={language.t("command.provider.connect")}>
          <Content />
        </Dialog>
      }
    >
      <DialogV2
        containerClass="!h-[min(calc(100vh_-_16px),512px)] !w-[min(calc(100vw_-_16px),640px)]"
        class="[font-family:var(--v2-font-family-sans)] [&_[data-slot=dialog-header]]:!px-5 [&_[data-slot=dialog-header-title]]:!text-[15px] [&_[data-slot=dialog-header-title]]:!tracking-[-0.13px]"
      >
        <DialogHeader closeLabel={language.t("common.close")}>
          <DialogTitle>{language.t("command.provider.connect")}</DialogTitle>
        </DialogHeader>
        <DialogBody class="min-h-0 flex-1 overflow-hidden px-2 pb-2">
          <Content />
        </DialogBody>
      </DialogV2>
    </Show>
  )
}
