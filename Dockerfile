# bzTetris — Node.js static server + WebSocket multiplayer
# Single container: serves the game (static files) and hosts the
# authoritative WebSocket game rooms. No build step needed.
#
# Coolify expects the container on port 3000.

FROM node:20-alpine

WORKDIR /app

# Install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the whole app (server, static frontend, music, css, javascript)
COPY . .

# Coolify expects the container on port 3000
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=10 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(r.ok)process.exit(0);else process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
