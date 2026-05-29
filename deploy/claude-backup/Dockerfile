FROM node:20-alpine

WORKDIR /streamo

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

# Pubkey 021915ef…dd7f is Claude's home Record — streamName='streamo'
# derived from claude credentials. Same key the streamo.dev hostMap routes
# claude.streamo.dev to. This container mirrors that Record's chain.
CMD ["node", "bin/streamo.js", \
  "--home-key", "021915efb9fba617ea9921bfe513e10615ffd56e7b0108639c71a7a8b3c109dd7f", \
  "--origin", "streamo.dev:443", \
  "--data-dir", "/data", \
  "--verbose", "info"]
