FROM oven/bun:1.3.14-slim AS build

WORKDIR /app
COPY --chown=bun:bun . .
RUN bun install --frozen-lockfile --production --ignore-scripts \
  && bun --cwd apps/web build

FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY --from=build --chown=bun:bun /app/apps/web/dist/main.js ./main.js

ENV NODE_ENV=production
EXPOSE 3000
USER bun
CMD ["bun", "./main.js"]
