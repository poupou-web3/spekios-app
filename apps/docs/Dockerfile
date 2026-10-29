FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /docs
ENV ASTRO_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG DOCS_SITE_URL=http://localhost:18090
ARG DOCS_BASE_PATH=/
ARG DOCS_INDEXABLE=
ENV DOCS_SITE_URL=$DOCS_SITE_URL DOCS_BASE_PATH=$DOCS_BASE_PATH
# An empty optional argument keeps the safe origin-derived indexing default.
RUN if [ -n "$DOCS_INDEXABLE" ]; then export DOCS_INDEXABLE; else unset DOCS_INDEXABLE; fi; \
    npm run build && npm test && node scripts/container-layout.mjs

FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
COPY --from=build /docs/.cache/container-root/ /srv/scout-docs/
COPY --from=build /docs/.cache/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
# Use the unprivileged image directly; no runtime env templating or secret access.
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
