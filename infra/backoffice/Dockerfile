# Operator back office: its own deployment, separate from the customer workspace served by scout-api.
FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
COPY infra/backoffice/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/backoffice/index.html /srv/backoffice/index.html
COPY apps/backoffice/favicon.svg /srv/backoffice/favicon.svg
COPY apps/backoffice/src /srv/backoffice/assets/app
COPY packages/web-ui/src /srv/backoffice/assets/ui
EXPOSE 8080
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
