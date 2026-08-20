# SeenSnap FastAPI — Cloud Run image.
#
# Slim Python 3.12 base to match pyproject.toml. Cloud Run injects PORT
# at runtime (defaults to 8080) — uvicorn binds to that + 0.0.0.0.
# Runs as a non-root user for the usual container hygiene reasons.

FROM python:3.12-slim AS runtime

# System libraries psycopg[binary] doesn't need at runtime (it ships the C
# extension) — keeping the image lean. If we ever switch to psycopg2 or the
# non-binary variant, add build-essential + libpq-dev here.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Copy dependency manifest first so pip install layers cache when only
# application code changes.
COPY pyproject.toml ./
# psycopg[binary] talks to Cloud SQL via the unix socket that Cloud Run
# provisions at /cloudsql/{INSTANCE_CONNECTION_NAME} when you attach the
# instance with `--add-cloudsql-instances`. No extra connector library
# needed — DATABASE_URL of the form
#   postgresql+psycopg://USER:PASS@/DB?host=/cloudsql/{project}:{region}:{instance}
# is enough.
RUN pip install --no-cache-dir .

# Now copy the rest of the app.
COPY app ./app
COPY alembic.ini ./alembic.ini
COPY alembic ./alembic
COPY scripts ./scripts

# Non-root runtime user. `runner` owns /app so it can read config and
# scripts. Uploads land under /app/uploads which is ephemeral on Cloud Run
# — real user uploads should eventually go to Cloud Storage; for staging
# the local dir is fine.
RUN useradd --create-home --uid 10001 --shell /bin/bash runner \
    && chown -R runner:runner /app
USER runner

# Cloud Run's $PORT is 8080 by default. Do not hardcode.
ENV PORT=8080
EXPOSE 8080

# Health probe: /health is registered in app/main.py.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request, os, sys; \
        urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\", \"8080\")}/health', timeout=3); \
        sys.exit(0)" || exit 1

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
