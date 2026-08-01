FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq-dev gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5000

# Shell form (not exec-array form) so $PORT actually expands - Render injects
# its own PORT env var (not 5000) and health-checks whatever port the app
# actually binds to. Falls back to 5000 when PORT isn't set (e.g. local
# `docker build && docker run` outside docker-compose, which overrides this
# CMD with its own --port=5000 anyway).
CMD gunicorn --bind 0.0.0.0:${PORT:-5000} wsgi:app
