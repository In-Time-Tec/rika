# @rika/motel

`packages/motel/` is Rika's vendored fork of upstream `kitlangton/motel`. Keep upstream source recognizable so future upstream syncs stay cheap, but put Rika-specific behavior directly in this package instead of patching `node_modules`.

Because this package is vendored upstream source, existing upstream comments may remain. New Rika-specific deltas should still avoid adding code comments.

Rika-owned behavior in this fork:

- `MOTEL_TUI_SERVICE_NAME` seeds the initial selected service.
- `MOTEL_TUI_ATTR_KEY` and `MOTEL_TUI_ATTR_VALUE` seed the initial trace attribute filter.
- `MOTEL_TUI_THEME` seeds the initial TUI theme.
- The `rika` theme matches the Rika TUI palette.

When syncing upstream, preserve these behaviors or replace them with an upstream equivalent before deleting local code.

The vendored npm package includes `web/dist` without the web source. Keep that directory committed until this fork gains source-based web builds or Rika intentionally drops the motel browser UI.
