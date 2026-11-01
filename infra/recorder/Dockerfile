FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
WORKDIR /app
COPY packages/image-diff/package*.json packages/image-diff/
RUN npm ci --prefix packages/image-diff --ignore-scripts --no-audit --no-fund
COPY packages/browser-runtime/package*.json packages/browser-runtime/
RUN npm ci --prefix packages/browser-runtime --ignore-scripts --no-audit --no-fund
COPY packages/image-diff/index.mjs packages/image-diff/index.mjs
# The Larchwood shop with known bugs: the larchwood service and its browser test.
COPY apps/bug-lab/ apps/bug-lab/
COPY packages/browser-runtime/ packages/browser-runtime/
RUN mkdir -p /data/recorder /data/auth && chown -R pwuser:pwuser /data/recorder /data/auth
USER pwuser
WORKDIR /app/packages/browser-runtime
ENTRYPOINT ["./node_modules/.bin/tsx", "src/cli.ts"]
CMD ["demo"]
