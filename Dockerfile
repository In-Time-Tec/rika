FROM oven/bun:1.3.14-slim

WORKDIR /app

COPY --chown=bun:bun . .
RUN bun install --frozen-lockfile

ENV NODE_ENV=production
EXPOSE 3000
USER bun

CMD ["bun", "--cwd", "apps/control-plane", "start"]
