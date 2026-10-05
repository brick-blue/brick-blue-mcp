# brick.blue as a local stdio MCP server (server/): read-only tools over the hub's public REST
# API — search, listings, liveness, verify, tasks, x402 prices. Signed actions (calling a listed
# tool, claiming work, paying) are on the hosted server at https://brick.blue/mcp.
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/server.js ./
ENTRYPOINT ["node", "server.js"]
