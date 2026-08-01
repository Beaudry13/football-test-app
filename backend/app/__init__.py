"""Application factory."""

import os

from flask import Flask, jsonify, send_from_directory

from app.config import get_config
from app.errors import register_error_handlers
from app.extensions import bcrypt, cors, db, jwt, limiter, migrate


def create_app(env_name: str | None = None) -> Flask:
    app = Flask(__name__)
    app.config.from_object(get_config(env_name))
    _validate_storage_config(app)

    if app.config["STORAGE_BACKEND"] == "local":
        os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

    _init_extensions(app)
    register_error_handlers(app)

    from app.routes import register_blueprints

    register_blueprints(app)

    @app.get("/api/health")
    def health_check():
        return jsonify({"status": "ok"})

    @app.get("/uploads/<path:filename>")
    def serve_uploaded_file(filename: str):
        return send_from_directory(app.config["UPLOAD_FOLDER"], filename)

    return app


def _validate_storage_config(app: Flask) -> None:
    """Fail fast at startup on a misconfigured S3 backend instead of 500ing
    on the first image upload a coach tries in production."""
    if app.config["STORAGE_BACKEND"] != "s3":
        return
    required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL_BASE"]
    missing = [key for key in required if not app.config.get(key)]
    if missing:
        raise RuntimeError(
            f"STORAGE_BACKEND=s3 requires {', '.join(missing)} to be set"
        )


def _init_extensions(app: Flask) -> None:
    db.init_app(app)
    migrate.init_app(app, db)
    bcrypt.init_app(app)
    jwt.init_app(app)
    cors.init_app(app, resources={r"/api/*": {"origins": app.config["CORS_ORIGINS"]}})
    limiter.init_app(app)

    # Import models so Flask-Migrate can see them for autogeneration.
    from app import models  # noqa: F401
