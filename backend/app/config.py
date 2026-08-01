"""Application configuration, loaded from environment variables."""

import os
import tempfile
from datetime import timedelta

from dotenv import load_dotenv

load_dotenv()


def _split_origins(raw: str) -> list[str]:
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


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

    UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "uploads")
    MAX_CONTENT_LENGTH = int(os.environ.get("MAX_UPLOAD_SIZE_MB", "10")) * 1024 * 1024
    ALLOWED_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}

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
