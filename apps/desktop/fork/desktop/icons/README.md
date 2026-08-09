# Rika icons

The channel icon directories contain the Rika mark in the sizes consumed by Electron Builder and the desktop runtime.

`bun ./scripts/copy-icons.ts <dev|beta|prod>` copies one channel into `resources/icons` before development or packaging. Electron uses `icon.icns` and `icon.ico` for installers, the Linux PNG set for desktop entries, and `dock.png` for the unpackaged macOS Dock icon.
