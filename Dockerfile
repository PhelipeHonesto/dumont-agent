FROM node:22-slim

# better-sqlite3 needs build tools for native module compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json ./
COPY dashboard/package.json ./dashboard/
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3

# Copy source (data/ is excluded via .dockerignore — lives on volume)
COPY . .

# Volume mount point for SQLite database
VOLUME ["/data"]

EXPOSE 3001

# Default: API server. Override CMD for worker/cron services.
CMD ["npm", "run", "server"]
