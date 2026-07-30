FROM node:20.19.2-bookworm-slim
# node-pty compiles a native addon at install time
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY bin ./bin
COPY scripts ./scripts
COPY cli-pins.json ./
# npm pins bake into the image at their manifest-exact versions; external pins
# (agy) have no public registry — bind-mount them at /app/vendor/bin at runtime.
RUN node scripts/pin-clis.mjs --npm-only
# Vendored CLIs on PATH for `docker exec` flows (one-time logins etc.); the
# bridge itself resolves absolute vendored paths regardless.
ENV PATH=/app/vendor/node_modules/.bin:/app/vendor/bin:$PATH
# Reuse the base image's `node` user (uid/gid 1000) so bind-mounted host
# credential dirs (~ typically uid 1000) stay readable in the container.
RUN chown -R node /app
USER node
ENV HOST=0.0.0.0 PORT=7681
EXPOSE 7681
CMD ["node", "src/server.js"]
