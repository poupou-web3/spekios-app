FROM rust:1.91.0-slim-bookworm@sha256:81c97592d519ba7397e8adccb0345fb5a91965c0a44b82af83bd1ef06c36cef5 AS build
WORKDIR /build
COPY apps/api/Cargo.toml apps/api/Cargo.lock apps/api/build.rs ./
COPY apps/api/src ./src
# Required by the opt-in disposable-database auth integration test.
COPY infra/postgres/024-web-auth.sql /infra/postgres/024-web-auth.sql
COPY infra/postgres/025-provider-access.sql /infra/postgres/025-provider-access.sql
COPY apps/web /web
COPY packages/web-ui/src /packages/web-ui/src
COPY packages/cli/spekios.mjs /packages/cli/spekios.mjs
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo test --locked && cargo build --locked --release && cp target/release/scout-api /build/scout-api

FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
RUN mkdir -p /data/gateway && chown 65532:65532 /data/gateway && chmod 700 /data/gateway
COPY --from=build /build/scout-api /usr/local/bin/scout-api
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/scout-api"]
