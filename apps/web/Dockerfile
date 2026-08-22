FROM oven/bun:1.4.0-slim AS build

WORKDIR /app
COPY --chown=bun:bun . .
RUN bun install --frozen-lockfile --production --ignore-scripts \
  && bun --cwd apps/web build

FROM oven/bun:1.4.0-slim
WORKDIR /app
COPY --from=build --chown=bun:bun /app/apps/web/dist ./dist

ENV NODE_ENV=production
EXPOSE 3000
USER bun
CMD ["bun", "./dist/server/main.js"]
