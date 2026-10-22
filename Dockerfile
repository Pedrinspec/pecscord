# Etapa 1: interface (Vite)
FROM node:22-alpine AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Etapa 2: servidor (Rust)
FROM rust:1-slim-bookworm AS server
WORKDIR /app/server
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
RUN cargo build --release

# Etapa 3: imagem final, só com o binário e os arquivos estáticos
FROM debian:bookworm-slim
WORKDIR /app
COPY --from=server /app/server/target/release/pecscord-server ./pecscord-server
COPY --from=client /app/client/dist ./static
ENV STATIC_DIR=/app/static
ENV PORT=3000
EXPOSE 3000
CMD ["/app/pecscord-server"]
