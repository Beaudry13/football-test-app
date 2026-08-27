"""Application configuration, loaded from environment variables."""

import os
import tempfile
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv

# backend/ - the directory this config lives under, independent of the
# process's cwd or Flask's app.root_path (which is backend/app/, not backend/).
BASE_DIR = Path(__file__).resolve().parent.parent

# Resolved against BASE_DIR rather than left to load_dotenv()'s default
# cwd-upward search, which silently finds nothing (or, worse, the wrong
# .env) when the process is launched from outside backend/.
load_dotenv(BASE_DIR / ".env")


def _split_origins(raw: str) -> list[str]:
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


def _resolve_upload_folder(raw: str) -> str:
    """Relative paths are resolved against BASE_DIR, not cwd or Flask's root_path.

    Without this, `FileStorage.save()` (relative to cwd) and Flask's
    `send_from_directory()` (relative to app.root_path) would silently
    disagree on where "uploads" actually is.
    """
    path = Path(raw)
    return str(path if path.is_absolute() else BASE_DIR / path)


# Dev-only fallback secrets, visible in the public repo - never valid in
# production. Named here (not inlined) so app/__init__.py's production
# startup check can compare against the exact same values rather than
# duplicating the literal strings.
DEV_SECRET_KEY_DEFAULT = "dev-secret-key-not-for-production-use-32b"
DEV_JWT_SECRET_KEY_DEFAULT = "dev-jwt-secret-key-not-for-production-32b"


class BaseConfig:
    """Shared configuration for all environments."""

    # Defaults are only for local dev convenience — real deployments must set
    # SECRET_KEY/JWT_SECRET_KEY explicitly. 32+ bytes to satisfy PyJWT's
    # minimum recommended HMAC-SHA256 key length.
    SECRET_KEY = os.environ.get("SECRET_KEY", DEV_SECRET_KEY_DEFAULT)
    JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY", DEV_JWT_SECRET_KEY_DEFAULT)
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(hours=12)

    #: Encrypts a PENDING coach invitation's token so the owner can reopen and
    #: reshare the same code. Deliberately its own secret rather than a reuse
    #: of SECRET_KEY: one key, one purpose, and a rotation of either must not
    #: silently affect the other.
    #:
    #: NO DEV DEFAULT, on purpose. The other two default so a new machine runs
    #: at all; this one degrades to today's hash-only behaviour when absent,
    #: which is a correct and fully working state - a default would only hide
    #: from an operator that production is missing it. Any high-entropy string
    #: works; the key is derived (see services/invite_secrets).
    INVITE_TOKEN_KEY = os.environ.get("INVITE_TOKEN_KEY")

    SQLALCHEMY_DATABASE_URI = os.environ.get("DATABASE_URL")
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    UPLOAD_FOLDER = _resolve_upload_folder(os.environ.get("UPLOAD_FOLDER", "uploads"))
    ALLOWED_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}

    # --- Upload size limits -------------------------------------------------
    # MAX_CONTENT_LENGTH is enforced by Werkzeug for EVERY request, before any
    # route runs, so it can only ever be the *largest* thing the app accepts.
    # A playbook PDF is far bigger than a film still, so raising it to the PDF
    # ceiling would silently remove the image cap that used to be enforced
    # here for free.
    #
    # So the image cap moves into the image path itself
    # (file_storage._compress_image) where it can be enforced per upload type,
    # and this global value becomes what it should always have been: a coarse
    # backstop against a request nobody could have a legitimate reason to send.
    IMAGE_MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_SIZE_MB", "10")) * 1024 * 1024
    PDF_MAX_UPLOAD_BYTES = int(os.environ.get("PDF_MAX_UPLOAD_SIZE_MB", "50")) * 1024 * 1024
    MAX_CONTENT_LENGTH = max(IMAGE_MAX_UPLOAD_BYTES, PDF_MAX_UPLOAD_BYTES)

    # A playbook with more pages than this is far more likely to be a
    # decompression bomb or a mis-selected file than a real install book, and
    # rendering thumbnails for it happens synchronously on the request.
    PDF_MAX_PAGES = int(os.environ.get("PDF_MAX_PAGES", "400"))
    # Every accepted upload is recompressed to a JPEG capped at this longest
    # dimension - comfortably above MAX_CANVAS_WIDTH (1400, see
    # frontend/src/components/annotation/canvasSizing.ts) so it's never the
    # binding constraint on annotation coordinate space, while still cutting
    # typical 3000-4000px phone photos down significantly for players on
    # weak cell signal.
    IMAGE_MAX_DIMENSION = int(os.environ.get("IMAGE_MAX_DIMENSION", "2400"))
    IMAGE_JPEG_QUALITY = int(os.environ.get("IMAGE_JPEG_QUALITY", "88"))

    # "local" (default, disk-backed) or "s3" (R2/S3-compatible bucket, see
    # app/services/file_storage.py) - most PaaS hosts wipe local disk on
    # every redeploy, so a production deployment should set this to "s3".
    STORAGE_BACKEND = os.environ.get("STORAGE_BACKEND", "local")
    R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID")
    R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID")
    R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY")
    R2_BUCKET_NAME = os.environ.get("R2_BUCKET_NAME")
    R2_PUBLIC_URL_BASE = os.environ.get("R2_PUBLIC_URL_BASE")

    # --- Private document storage -------------------------------------------
    # Deliberately a DIFFERENT BUCKET, not a prefix inside R2_BUCKET_NAME.
    #
    # A prefix called "private/" provides no privacy whatsoever: if the public
    # hostname in R2_PUBLIC_URL_BASE is bound to the bucket root, then every
    # object in that bucket is readable by anyone who knows or guesses its
    # key, prefix or not. Playbooks are the one asset in this product where
    # that would be a genuine competitive loss, so privacy here is a property
    # of the bucket's own configuration - it must have NO public binding at
    # all - rather than of anything this code does.
    #
    # There is intentionally no R2_PRIVATE_PUBLIC_URL_BASE. Nothing in the
    # codebase can construct a public URL for a private object because no such
    # value exists to construct it from.
    R2_PRIVATE_BUCKET_NAME = os.environ.get("R2_PRIVATE_BUCKET_NAME")

    # Local-dev equivalent. Must sit OUTSIDE UPLOAD_FOLDER: create_app serves
    # UPLOAD_FOLDER wholesale at /uploads/<path:filename>, so a private asset
    # written underneath it would be downloadable without any credential.
    # There is a test that fails if these two paths ever overlap.
    PRIVATE_UPLOAD_FOLDER = _resolve_upload_folder(
        os.environ.get("PRIVATE_UPLOAD_FOLDER", "private_uploads")
    )

    # How long a signed media URL stays valid. Short by design: the browser
    # only needs it long enough to load an image, and every payload that
    # contains one is generated fresh on request.
    SIGNED_MEDIA_TTL_SECONDS = int(os.environ.get("SIGNED_MEDIA_TTL_SECONDS", "600"))

    CORS_ORIGINS = _split_origins(os.environ.get("CORS_ORIGINS", "http://localhost:5173"))

    ACCESS_CODE_TTL_HOURS = int(os.environ.get("ACCESS_CODE_TTL_HOURS", "24"))


class DevelopmentConfig(BaseConfig):
    DEBUG = True


class TestingConfig(BaseConfig):
    TESTING = True
    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "TEST_DATABASE_URL",
        "postgresql://quiz_user:quiz_password@localhost:5432/football_quiz_test",
    )
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(hours=1)
    UPLOAD_FOLDER = os.environ.get(
        "TEST_UPLOAD_FOLDER", os.path.join(tempfile.gettempdir(), "football_quiz_test_uploads")
    )
    PRIVATE_UPLOAD_FOLDER = os.environ.get(
        "TEST_PRIVATE_UPLOAD_FOLDER",
        os.path.join(tempfile.gettempdir(), "football_quiz_test_private"),
    )
    # Rate limits exist to slow down abuse (credential stuffing, access-code
    # brute-forcing), not something the test suite is exercising - many tests
    # legitimately call register/login/submit more times per minute than a
    # real abuser would be allowed to.
    RATELIMIT_ENABLED = False


class ProductionConfig(BaseConfig):
    DEBUG = False


CONFIG_BY_NAME = {
    "development": DevelopmentConfig,
    "testing": TestingConfig,
    "production": ProductionConfig,
}


def get_config(env_name: str):
    """Looks up a config class by resolved environment name.

    Raises rather than silently falling back to DevelopmentConfig on an
    unrecognized name (e.g. a typo'd FLASK_ENV=prodution) - a production
    deploy should fail loudly at startup instead of quietly running with
    development settings (debug output, permissive defaults, etc.)."""
    if env_name not in CONFIG_BY_NAME:
        raise RuntimeError(
            f"Unknown FLASK_ENV: {env_name!r} (expected one of {sorted(CONFIG_BY_NAME)})"
        )
    return CONFIG_BY_NAME[env_name]
