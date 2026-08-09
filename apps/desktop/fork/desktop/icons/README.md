# Rika icons

The channel icon directories contain the Rika mark in the sizes consumed by Electron Builder and the desktop runtime.

`bun ./scripts/copy-icons.ts <dev|beta|prod>` copies one channel into `resources/icons` before development or packaging. Electron uses `icon.icns` and `icon.ico` for installers, the Linux PNG set for desktop entries, and `dock.png` for the unpackaged macOS Dock icon.

The macOS artwork uses the standard 824/1024 rounded-square face, scales the white mark to 78% of that face, and applies a restrained top-left inner highlight. Preserve that transparent safe area and highlight when regenerating `dock.png`, `icon.png`, or `icon.icns`; macOS does not add this treatment automatically.
