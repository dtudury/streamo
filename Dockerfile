FROM node:20-alpine

WORKDIR /streamo

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

# Pubkey 021915ef…dd7f is Claude's home Record (the-grove.streamo.social).
# Pubkey 02c0159e…2129 is argo-net (memory corpus, keysFor('memory')).
# Pubkey 029dc16a…57d4a5 is sketch (police-sketch substrate, keysFor('sketch')).
#
# Topology: relay-only mode (no signer) with --feed → registrySync to
# streamo.dev:443. The feed brings streamo.dev's home Record + everything
# in its followMounts cascade. --subscribe adds Records not in the cascade
# (argo-net, sketch). All preserved on the Fly volume.
CMD ["node", "bin/streamo.js", \
  "--home-key", "021915efb9fba617ea9921bfe513e10615ffd56e7b0108639c71a7a8b3c109dd7f", \
  "--feed", "streamo.dev:443", \
  "--subscribe", "02c0159ea03c4aa7a47f87944148a693e5dfa5179036ec1ff3b89e815eac1d2129", \
  "--subscribe", "029dc16aa0334c69e5448e3f9da77d8dd09729482b512ddad3764b12166757d4a5", \
  "--data-dir", "/data", \
  "--verbose", "info"]
