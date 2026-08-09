export function assertTrustedMainFrame<TSender extends { readonly mainFrame: unknown }>(
  event: { readonly sender: TSender; readonly senderFrame: unknown },
  fromWebContents: (sender: TSender) => { readonly webContents: TSender; readonly isDestroyed: () => boolean } | null,
) {
  const win = fromWebContents(event.sender)
  if (!win || win.isDestroyed() || win.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Invalid privileged IPC sender")
  }
}
