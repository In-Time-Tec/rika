// Rika fork stub: opencode's server bundle is deliberately NOT vendored.
// The desktop shell's `virtual:opencode-server` module resolves here; the
// M3 port replaces this with Rika's server/`@rika/client` spawn contract.
export const Server = {
  async listen(_opts) {
    return { async stop() {} }
  },
}
export const Config = {
  async get() {
    return {}
  },
}
export const bootstrap = async () => {}
export default { Server, Config, bootstrap }
