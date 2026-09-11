FROM oven/bun:1.4.0-slim

WORKDIR /app
COPY --chown=bun:bun . .
RUN bun install --frozen-lockfile --production --ignore-scripts

USER bun
EXPOSE 6420
CMD ["bun", "infra/rivet/start.ts"]
