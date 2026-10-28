FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
COPY server.mjs /fixture/server.mjs
COPY explorer.mjs /fixture/explorer.mjs
USER pwuser
ENTRYPOINT ["node","/fixture/server.mjs"]
