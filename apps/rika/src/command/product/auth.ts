import { Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { dispatch } from "../root/hosted"

export const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage your Rika identity"),
  Command.withSubcommands([
    Command.make(
      "login",
      {
        server: Flag.string("server").pipe(Flag.optional),
        noOpen: Flag.boolean("no-open").pipe(Flag.withDefault(false)),
      },
      ({ server, noOpen }) => {
        const selectedServer = Option.getOrUndefined(server)
        if (selectedServer === undefined) return dispatch({ _tag: "Auth", action: "login", noOpen })
        return dispatch({
          _tag: "Auth",
          action: "login",
          server: selectedServer,
          noOpen,
        })
      },
    ),
    Command.make("status", { json: Flag.boolean("json").pipe(Flag.withDefault(false)) }, ({ json }) =>
      dispatch({ _tag: "Auth", action: "status", json }),
    ),
    Command.make("logout", { all: Flag.boolean("all").pipe(Flag.withDefault(false)) }, ({ all }) =>
      dispatch(all ? { _tag: "Auth", action: "logout", all: true } : { _tag: "Auth", action: "logout" }),
    ),
    Command.make("devices", {}, () => dispatch({ _tag: "Auth", action: "devices" })),
    Command.make("revoke-device", { device: Argument.string("device").pipe(Argument.optional) }, ({ device }) => {
      const selectedDevice = Option.getOrUndefined(device)
      if (selectedDevice === undefined) return dispatch({ _tag: "Auth", action: "revoke-device" })
      return dispatch({
        _tag: "Auth",
        action: "revoke-device",
        device: selectedDevice,
      })
    }),
  ]),
)
