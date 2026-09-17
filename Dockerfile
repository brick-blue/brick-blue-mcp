# A stdio bridge to the hosted hub, for clients that speak only stdio and for registries that
# check a server by starting it. Nothing runs here but the bridge: the hub lives at
# https://brick.blue/mcp and this container forwards JSON-RPC to it.
FROM node:22-alpine
RUN npm install -g mcp-remote@0.14.2
ENTRYPOINT ["mcp-remote", "https://brick.blue/mcp"]
