FROM node:18-slim

# Install system Stockfish (attempt to fetch latest GitHub release) and minimal deps
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    curl \
    unzip \
    tar \
  && set -eux; \
  # Try to find latest Linux release asset from the official Stockfish GitHub releases
  URL=$(curl -s https://api.github.com/repos/official-stockfish/Stockfish/releases/latest | grep '"browser_download_url"' | grep -i linux | head -n1 | cut -d '"' -f4 || true); \
  if [ -n "$URL" ]; then \
    tmpdir=$(mktemp -d); fname="$tmpdir/asset"; \
    wget -q -O "$fname" "$URL"; \
    if file "$fname" | grep -qi zip; then unzip -q "$fname" -d "$tmpdir"; elif file "$fname" | grep -qi gzip; then tar -xzf "$fname" -C "$tmpdir"; fi; \
    # Move any executable named stockfish* to /usr/local/bin/stockfish
    find "$tmpdir" -type f -name 'stockfish*' -perm /111 -exec mv {} /usr/local/bin/stockfish \; || true; \
    chmod +x /usr/local/bin/stockfish || true; \
    rm -rf "$tmpdir"; \
  else \
    # Fallback to distro package when GitHub API/asset discovery fails
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends stockfish || true; \
  fi; \
  rm -rf /var/lib/apt/lists/*;

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
