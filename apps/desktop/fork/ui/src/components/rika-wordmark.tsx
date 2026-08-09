// Exact RIKA glyph geometry from the supplied 48px-grid brand wordmark, normalized to 6px units.
export function RikaWordmarkPaths(props: { fill: string }) {
  return (
    <g transform="translate(0 3)">
      <path
        d="M64.5 0H94.5V6H64.5V0ZM64.5 6H70.5V12H64.5V6ZM88.5 6H94.5V12H88.5V6ZM64.5 12H94.5V18H64.5V12ZM64.5 18H70.5V36H64.5V18ZM82.5 24H88.5V30H82.5V24ZM82.5 30H94.5V36H82.5V30Z"
        fill={props.fill}
      />
      <path d="M99.5 0H105.5V36H99.5V0Z" fill={props.fill} />
      <path
        d="M110.5 0H116.5V36H110.5V0ZM128.5 0H134.5V6H128.5V0ZM122.5 6H128.5V12H122.5V6ZM116.5 12H122.5V18H116.5V12ZM122.5 18H128.5V24H122.5V18ZM128.5 24H134.5V36H128.5V24Z"
        fill={props.fill}
      />
      <path
        d="M139.5 0H169.5V6H139.5V0ZM139.5 6H145.5V36H139.5V6ZM157.5 6H163.5V36H157.5V6ZM145.5 12H157.5V18H145.5V12Z"
        fill={props.fill}
      />
    </g>
  )
}
