# ATLAS V2 (proposal) — one image with the web pages and the small API behind them.
# Standard Docker, nothing host-specific. It listens on port 8000 inside the container.

# ---- 1. build the web pages (React + Vite) to static files ----------------------------
FROM node:22-slim AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- 2. the API (FastAPI), which also serves the built pages --------------------------
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    STATIC_DIR=/app/static \
    DATA_DIR=/data

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install -r requirements.txt

COPY backend/app ./app
COPY --from=frontend /src/dist ./static

# /data holds the copy of the cards read from ATLAS, so a restart does not have to read them again.
RUN useradd --create-home --uid 10001 appuser && mkdir -p /data && chown appuser /data
VOLUME /data
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
