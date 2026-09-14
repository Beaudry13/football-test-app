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
#
# ONE PROCESS, FOUR THREADS - and both numbers are deliberate.
#
# THREADS, NOT WORKERS. The rate limiter keeps its counts in this process's
# memory (flask-limiter memory storage). A second worker process would hold its
# own separate counts, silently turning every limit into "per worker". Threads
# share one process, so every limit still means what it says. `--workers 1` is
# pinned explicitly because gunicorn otherwise reads WEB_CONCURRENCY, and an
# environment variable must not be able to split the limiter behind our backs.
#
# WHY THREADS AT ALL. One synchronous worker served every request in series, so
# one slow request - a detailed PDF, a clip upload, a player PIN check (~90ms
# of bcrypt each) - made every other player wait behind it.
#
# WHY 4. Checked before changing: requests get their own SQLAlchemy session
# (Flask-SQLAlchemy scopes it to the app context), the default pool of 5
# connections covers 4 threads, the limiter's memory storage takes a lock,
# boto3 clients are built per call (1,600 concurrent constructions from 32
# threads raised nothing), and there is no module-level mutable state or
# background thread. Four keeps peak memory well inside the Starter plan while
# several heavy exports run at once.
CMD gunicorn --bind 0.0.0.0:${PORT:-5000} --workers 1 --threads 4 wsgi:app
