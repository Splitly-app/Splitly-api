ARG BUN_IMAGE=oven/bun:1.4.3
FROM ${BUN_IMAGE} AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --network-concurrency=8

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app
ARG APP_VERSION=unknown
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 APP_VERSION=${APP_VERSION}
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json ./package.json
COPY --chown=bun:bun src ./src
USER bun
EXPOSE 3001
CMD ["bun", "src/server.ts"]
