FROM oven/bun:1.4.0-slim

WORKDIR /app
COPY --chown=bun:bun package.json start.ts ./
RUN bun install --production --ignore-scripts

EXPOSE 6420
CMD ["bun", "start.ts"]
