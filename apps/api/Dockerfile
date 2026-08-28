FROM oven/bun:1.4.0-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends gzip tar zstd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=bun:bun . .
RUN bun install --frozen-lockfile --production --ignore-scripts

ENV NODE_ENV=production
EXPOSE 3000
USER bun
CMD ["bun", "--cwd", "apps/api", "start"]
