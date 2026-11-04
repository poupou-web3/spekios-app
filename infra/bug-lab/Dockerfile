# Reuse the pinned Node runtime already present on Spekios hosts; no npm install,
# worker code, model credentials or evidence files enter this image.
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
WORKDIR /app
COPY apps/bug-lab/ apps/bug-lab/
USER pwuser
ENTRYPOINT ["node", "/app/apps/bug-lab/server.mjs", "--pair", "--host", "0.0.0.0", "--port", "8084"]
