# DecisionMatrix MCP — local stdio server image (self-host / Glama introspection).
# Build:  docker build -t decisionmatrix-mcp .
# Run:    docker run --rm -i decisionmatrix-mcp        # speaks MCP over stdio
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# The stdio MCP server: starts immediately and answers introspection (tools/list).
CMD ["node", "server.mjs"]
