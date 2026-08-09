import { createUniqueId, type ComponentProps } from "solid-js"
import { RikaWordmarkPaths } from "../../components/rika-wordmark"

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      data-component="logo-wordmark"
      viewBox="0 0 234 42"
      fill="none"
      aria-hidden="true"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.6">
        <g mask={`url(#${mask})`}>
          <g opacity="0.16">
            <g opacity="0.7">
              <RikaWordmarkPaths fill="currentColor" />
            </g>
          </g>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="234" height="42">
          <rect width="234" height="42" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="117" y1="22" x2="117" y2="42" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
