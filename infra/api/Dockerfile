FROM rust:1.91.0-slim-bookworm@sha256:81c97592d519ba7397e8adccb0345fb5a91965c0a44b82af83bd1ef06c36cef5 AS build
WORKDIR /build
COPY apps/api/Cargo.toml apps/api/Cargo.lock ./
COPY apps/api/src ./src
COPY apps/web /web
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo test --locked && cargo build --locked --release && cp target/release/scout-api /build/scout-api

FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
RUN mkdir -p /data/gateway && chown 65532:65532 /data/gateway && chmod 700 /data/gateway
COPY --from=build /build/scout-api /usr/local/bin/scout-api
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/scout-api"]
