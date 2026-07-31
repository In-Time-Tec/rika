import { createCliRenderer, TextRenderable, RGBA, StyledText, fg, dim, bold, italic } from "@opentui/core"

const renderer = await createCliRenderer({ screenMode: "alternate-screen", exitOnCtrlC: true })
const text = new TextRenderable(renderer, {
  content: new StyledText([
    fg(RGBA.fromIndex(2))("GREEN2"),
    fg(RGBA.defaultForeground())(" DEFAULTFG"),
    dim(fg(RGBA.defaultForeground())(" DIMDEF")),
    fg(RGBA.fromIndex(8))(" ANSI8"),
    bold(fg(RGBA.fromIndex(3))(" YELLOWBOLD")),
    italic(fg(RGBA.fromIndex(2))(" GREENITALIC")),
    fg("#3dffa6")(" MINT"),
  ]),
})
renderer.root.add(text)
