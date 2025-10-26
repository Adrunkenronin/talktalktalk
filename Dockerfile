FROM node:18-slim

# Install system Stockfish and minimal deps
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    stockfish \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Install production dependencies first
COPY package.json package-lock.json ./
RUN npm ci --production --silent

# Copy app sources
COPY . ./

ENV NODE_ENV=production

# Render (and many hosts) provide PORT env; server.js falls back to 12000
EXPOSE 12000

CMD ["npm", "start"]
