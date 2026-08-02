"""Application configuration, loaded from environment variables."""

import os
import tempfile
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# backend/ - the directory this config lives under, independent of the
# process's cwd or Flask's app.root_path (which is backend/app/, not backend/).
BASE_DIR = Path(__file__).resolve().parent.parent


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


class BaseConfig:
    """Shared configuration for all environments."""

    # Defaults are only for local dev convenience — real deployments must set
    # SECRET_KEY/JWT_SECRET_KEY explicitly. 32+ bytes to satisfy PyJWT's
    # minimum recommended HMAC-SHA256 key length.
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-key-not-for-production-use-32b")
    JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY", "dev-jwt-secret-key-not-for-production-32b")
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(hours=12)

    SQLALCHEMY_DATABASE_URI = os.environ.get("DATABASE_URL")
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    UPLOAD_FOLDER = _resolve_upload_folder(os.environ.get("UPLOAD_FOLDER", "uploads"))
    MAX_CONTENT_LENGTH = int(os.environ.get("MAX_UPLOAD_SIZE_MB", "10")) * 1024 * 1024
    ALLOWED_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}
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


def get_config(env_name: str | None = None):
    env_name = env_name or os.environ.get("FLASK_ENV", "development")
    return CONFIG_BY_NAME.get(env_name, DevelopmentConfig)
