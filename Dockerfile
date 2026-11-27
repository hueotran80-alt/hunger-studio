# syntax=docker/dockerfile:1

FROM node:20-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY vite.config.js index.html embed.html ./
COPY css/ ./css/
COPY js/ ./js/
COPY vendor/ ./vendor/
COPY models/ ./models/
COPY assets/ ./assets/
RUN npm run build


FROM python:3.11-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    STUDIO_HOST=0.0.0.0 \
    PORT=8080 \
    WS_PORT=8082

WORKDIR /app

# Core runtime only needs websockets>=14.0; mocap/rendering run client-side in WASM/WebCodecs.
RUN pip install --no-cache-dir "websockets>=14.0"

RUN useradd --create-home --shell /bin/sh studio
COPY server.py ./
COPY cloud/ ./cloud/
COPY cloud_config.example.json LICENSE THIRD_PARTY_LICENSES.md PRIVACY.md TERMS.md ./
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/cloud_data && chown -R studio:studio /app
USER studio

EXPOSE 8080 8082

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os, urllib.request; p=os.environ.get('PORT','8080'); urllib.request.urlopen(f'http://127.0.0.1:{p}/healthz', timeout=3).read()"

# Auto-generate an ephemeral admin STUDIO_TOKEN if not supplied so server.py's
# non-loopback admin endpoints remain locked while /, /embed.html, /healthz & /api/cloud/* stay reachable.
CMD ["sh", "-c", "if [ -z \"$STUDIO_TOKEN\" ]; then export STUDIO_TOKEN=$(python -c 'import secrets; print(secrets.token_urlsafe(32))'); fi; exec python server.py --dist --host 0.0.0.0 --port ${PORT:-8080} --ws-port ${WS_PORT:-8082}"]
