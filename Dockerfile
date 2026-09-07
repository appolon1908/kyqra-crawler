FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci && npm cache clean --force
COPY scripts/copy-static.mjs ./scripts/copy-static.mjs
COPY migrations ./migrations
COPY src ./src
RUN npm run build && npm prune --omit=dev --omit=optional

FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e AS runtime
ARG SOURCE_COMMIT_SHA
RUN test "$(printf '%s' "$SOURCE_COMMIT_SHA" | wc -c)" -eq 40 \
    && case "$SOURCE_COMMIT_SHA" in *[!0-9a-f]*) exit 1 ;; *) : ;; esac
WORKDIR /app
USER root
RUN apt-get purge -y --auto-remove gstreamer1.0-plugins-bad libgstreamer-plugins-bad1.0-0 \
    && rm -rf /var/lib/apt/lists/* /usr/lib/node_modules/npm /usr/lib/node_modules/yarn \
      /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/yarn \
      /usr/bin/npm /usr/bin/npx /usr/bin/yarn /usr/bin/yarnpkg /root/.npm
COPY --from=build --chown=pwuser:pwuser /app/package.json /app/package-lock.json ./
COPY --from=build --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=build --chown=pwuser:pwuser /app/dist ./dist
COPY --from=build --chown=pwuser:pwuser /app/migrations ./migrations
RUN mkdir -p /app/storage && chown -R pwuser:pwuser /app/storage

# Flatten the sanitized runtime filesystem so removed package-manager cache and
# transient download metadata cannot survive in the published image history.
FROM scratch
ARG SOURCE_COMMIT_SHA
COPY --from=runtime / /
LABEL org.opencontainers.image.source="https://github.com/appolon1908-hue/kyqra-crawler" \
      org.opencontainers.image.revision="$SOURCE_COMMIT_SHA" \
      org.opencontainers.image.version="$SOURCE_COMMIT_SHA"
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright SOURCE_SHA=$SOURCE_COMMIT_SHA
USER pwuser
CMD ["node", "dist/main.js"]
