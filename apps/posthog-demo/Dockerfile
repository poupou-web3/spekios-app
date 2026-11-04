FROM node:24-bookworm-slim
WORKDIR /demo
COPY apps/posthog-demo/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/posthog-demo/server.mjs ./
COPY apps/posthog-demo/public ./public
USER node
ENV BIND=0.0.0.0 PORT=8086
EXPOSE 8086
CMD ["node", "server.mjs"]
