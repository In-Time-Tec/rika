/* oxlint-disable complexity -- hosted history transport wiring stays at the view boundary. */
import { Show } from "solid-js"
import type { AppProps, AppViewState } from "../app"
import { Transcript } from "./transcript"
import { Composer } from "./composer/composer"
import { ContextSidebar, isBusy, WelcomePanel } from "./sidebars"
import { FileSidebar, PendingQueue } from "./panels"
import {
  CommandPalette,
  ContextOverlay,
  ExitOverlay,
  FileCompletionOverlay,
  FilePreviewOverlay,
  ModeOverlay,
} from "./overlays"
import { ThreadSwitcherOverlay } from "./thread-overlay"
import { colors } from "./theme"

export function AppView(props: AppProps & { readonly state: AppViewState }) {
  const state = props.state
  const {
    hasTranscript,
    setFocus,
    selectedThread,
    focus,
    overlay,
    transcriptNavigation,
    contentWidth,
    narrow,
    contextual,
    openPalette,
    editing,
    pendingSelection,
    setPendingSelection,
    editPending,
    selectedId,
    drafts,
    updateDraft,
    submit,
    interruptAndSend,
    handlePaste,
    sidebarKind,
    allFilePaths,
    changedItems,
    fileSidebarWidth,
    openFile,
    paletteEntries,
    paletteIndex,
    paletteQuery,
    setPaletteQuery,
    choosePaletteEntry,
    closeOverlay,
    threadEntries,
    threadPickerMode,
    threadPickerIndex,
    threadPickerQuery,
    updatePicker,
    chooseThread,
    modeIndex,
    chooseMode,
    fileEntries,
    filePickerIndex,
    chooseFile,
    filePreview,
  } = state
  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={colors.surface} overflow="hidden">
      <box flexGrow={1} minHeight={0} width="100%" flexDirection="row">
        <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="column">
          <Show when={props.client.state.connection !== "offline" && props.client.state.connection !== "connected"}>
            <text
              width="100%"
              height={1}
              flexShrink={0}
              truncate
              fg={colors.amber}
              content={props.client.state.notice}
            />
          </Show>
          <Show
            when={hasTranscript()}
            fallback={<WelcomePanel client={props.client} animate={props.animate !== false} width={contentWidth()} />}
          >
            <box flexGrow={1} minHeight={0} overflow="hidden" onMouseDown={() => setFocus("transcript")}>
              <Transcript
                items={selectedThread()?.items ?? []}
                active={isBusy(selectedThread())}
                focused={focus() === "transcript" && overlay() === undefined}
                animate={props.animate !== false}
                navigation={transcriptNavigation}
                {...(props.client.loadOlder === undefined ? {} : { loadOlder: props.client.loadOlder })}
                {...(props.client.openChildSession === undefined
                  ? {}
                  : { openChildSession: props.client.openChildSession })}
                {...(props.client.backToThread === undefined ? {} : { backToThread: props.client.backToThread })}
                focusedSessionId={props.client.state.focusedSessionId}
                width={contentWidth()}
              />
            </box>
          </Show>
          <Show when={narrow() && contextual()}>
            <text
              width="100%"
              height={1}
              flexShrink={0}
              truncate
              fg={colors.amber}
              content={
                selectedThread()?.approval != null
                  ? " Approval required · Ctrl+O for actions"
                  : " Child runs · Ctrl+O for actions"
              }
              onMouseDown={() => openPalette()}
            />
          </Show>
          <Show when={(selectedThread()?.pending.length ?? 0) > 0}>
            <PendingQueue
              thread={selectedThread}
              editingId={editing()?.id}
              selectedId={pendingSelection()}
              select={setPendingSelection}
              edit={editPending}
              remove={(id) => {
                props.client.removePending(id)
                if (pendingSelection() === id) setPendingSelection(undefined)
              }}
              steer={(id) => {
                props.client.steerPending(id)
                if (pendingSelection() === id) setPendingSelection(undefined)
              }}
            />
          </Show>
          <Composer
            thread={selectedThread}
            mode={() => props.client.state.mode}
            threadId={selectedId}
            focused={focus() === "composer" && overlay() === undefined}
            drafts={drafts}
            updateDraft={updateDraft}
            setFocus={setFocus}
            submit={submit}
            interruptAndSend={interruptAndSend}
            editing={editing() !== undefined}
            help={overlay() === "shortcuts"}
            registerEditor={state.registerEditor}
            handleKey={state.composerKey}
            handlePaste={handlePaste}
          />
        </box>
        <Show when={!narrow() && contextual()}>
          <ContextSidebar client={props.client} thread={selectedThread} focus={focus} setFocus={setFocus} />
        </Show>
        <Show when={!narrow() && sidebarKind() !== undefined}>
          <FileSidebar
            files={allFilePaths()}
            diffs={changedItems()}
            kind={sidebarKind()!}
            width={fileSidebarWidth()}
            mode={props.client.state.mode}
            open={openFile}
          />
        </Show>
      </box>
      <Show when={overlay() === "palette"}>
        <CommandPalette
          entries={paletteEntries}
          index={paletteIndex}
          query={paletteQuery}
          setQuery={setPaletteQuery}
          choose={choosePaletteEntry}
          close={closeOverlay}
        />
      </Show>
      <Show when={overlay() === "threads"}>
        <ThreadSwitcherOverlay
          threads={threadEntries}
          kind={threadPickerMode()}
          index={threadPickerIndex}
          query={threadPickerQuery}
          setQuery={(query) =>
            updatePicker((value) => (value.kind === "thread" ? { ...value, query, index: 0 } : value))
          }
          choose={chooseThread}
          close={closeOverlay}
        />
      </Show>
      <Show when={overlay() === "exit"}>
        <ExitOverlay
          quit={props.onQuit}
          close={closeOverlay}
          contentWidth={contentWidth()}
          archiveAndNew={state.archiveAndNew}
          archiveAndQuit={state.archiveAndQuit}
        />
      </Show>
      <Show when={overlay() === "mode"}>
        <ModeOverlay
          mode={props.client.state.mode}
          index={modeIndex}
          choose={chooseMode}
          close={closeOverlay}
          contentWidth={contentWidth()}
        />
      </Show>
      <Show when={overlay() === "context"}>
        <ContextOverlay
          thread={selectedThread}
          close={closeOverlay}
          contentWidth={contentWidth()}
          mode={props.client.state.mode}
        />
      </Show>
      <Show when={overlay() === "file-picker"}>
        <FileCompletionOverlay entries={fileEntries()} index={filePickerIndex} choose={chooseFile} />
      </Show>
      <Show when={overlay() === "file-preview" && filePreview() !== undefined}>
        <FilePreviewOverlay path={filePreview()!.path} content={filePreview()!.content} close={closeOverlay} />
      </Show>
    </box>
  )
}
