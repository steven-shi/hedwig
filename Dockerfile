FROM rust:1.93.1-trixie@sha256:ecbe59a8408895edd02d9ef422504b8501dd9fa1526de27a45b73406d734d659 AS rust
FROM node:26-trixie@sha256:438603bbb5cda404b9416f0b5c8026f61501ab911760d861ec28c36b5d675725 AS runtime
WORKDIR /app
USER node

FROM runtime AS neo-build
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git python3 build-essential perl pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH CARGO_BUILD_JOBS=2
WORKDIR /build
COPY tools/prepare_groups.py tools/prepare_groups.py
COPY neo-overlay neo-overlay
RUN python3 tools/prepare_groups.py
WORKDIR /build/neo-group-source
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && cargo metadata --format-version 1 --manifest-path native/Cargo.toml --filter-platform aarch64-unknown-linux-gnu > /tmp/neo-dependencies.json \
    && npm run build:native && npm run build \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM runtime AS bridge
COPY --from=neo-build /build/neo-group-source/package.json ./package.json
COPY --from=neo-build /build/neo-group-source/LICENSE ./licenses/PUPPET-NEO-LICENSE
COPY --from=neo-build /build/neo-group-source/node_modules ./node_modules
COPY --from=neo-build /build/neo-group-source/dist ./dist
COPY --from=neo-build /build/neo-group-source/native/linux-arm64 ./native/linux-arm64
COPY bridge ./bridge
CMD ["node", "bridge/main.mjs"]

FROM runtime AS ai
COPY ai ./ai
COPY bridge/images.mjs bridge/errors.mjs ./bridge/
CMD ["node", "ai/server.mjs"]
