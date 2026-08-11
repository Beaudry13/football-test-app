"""Application factory."""

import os

from flask import Flask, jsonify, send_from_directory
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.config import DEV_JWT_SECRET_KEY_DEFAULT, DEV_SECRET_KEY_DEFAULT, get_config
from app.errors import register_error_handlers
from app.extensions import bcrypt, cors, db, jwt, limiter, migrate


def create_app(env_name: str | None = None) -> Flask:
    app = Flask(__name__)
    resolved_env = env_name or os.environ.get("FLASK_ENV", "development")
    app.config.from_object(get_config(resolved_env))
    _validate_production_secrets(app, resolved_env)
    _validate_storage_config(app)

    if app.config["STORAGE_BACKEND"] == "local":
        os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

    _init_extensions(app)
    register_error_handlers(app)

    from app.routes import register_blueprints

    register_blueprints(app)

    from app.cli import register_cli

    register_cli(app)

    @app.get("/api/health")
    def health_check():
        # Render's healthCheckPath (see render.yaml) hits this to decide
        # whether to route traffic to this instance / trigger a restart -
        # a plain {"status": "ok"} only proved Flask itself was up, not that
        # it could actually serve a request that touches the database.
        try:
            db.session.execute(text("SELECT 1"))
        except SQLAlchemyError:
            return jsonify({"status": "error", "detail": "database unreachable"}), 503
        return jsonify({"status": "ok"})

    @app.get("/uploads/<path:filename>")
    def serve_uploaded_file(filename: str):
        return send_from_directory(app.config["UPLOAD_FOLDER"], filename)

    return app


def _validate_production_secrets(app: Flask, env_name: str) -> None:
    """Fail fast at startup if production would boot with a missing or
    known-public dev fallback SECRET_KEY/JWT_SECRET_KEY, or no database -
    those fallback values are visible in this public repo's git history, so
    silently running with them in production would let anyone forge coach
    auth tokens. A misconfigured deploy should crash loudly, not log a
    warning and keep serving traffic with a known signing key."""
    if env_name != "production":
        return
    problems = []
    if not app.config.get("SECRET_KEY"):
        problems.append("SECRET_KEY is not set")
    elif app.config["SECRET_KEY"] == DEV_SECRET_KEY_DEFAULT:
        problems.append("SECRET_KEY is still the public dev default")
    if not app.config.get("JWT_SECRET_KEY"):
        problems.append("JWT_SECRET_KEY is not set")
    elif app.config["JWT_SECRET_KEY"] == DEV_JWT_SECRET_KEY_DEFAULT:
        problems.append("JWT_SECRET_KEY is still the public dev default")
    if not app.config.get("SQLALCHEMY_DATABASE_URI"):
        problems.append("DATABASE_URL is not set")
    if problems:
        raise RuntimeError("Refusing to start in production: " + "; ".join(problems))


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
    # /uploads/* needs CORS too, not just /api/* - the annotation canvas loads
    # question images cross-origin and requires a CORS-mode fetch (see
    # AnnotationCanvas.tsx's crossOrigin: 'anonymous') or the browser taints
    # the canvas and silently fails to render the image.
    cors.init_app(
        app,
        resources={
            r"/api/*": {"origins": app.config["CORS_ORIGINS"]},
            r"/uploads/*": {"origins": app.config["CORS_ORIGINS"]},
        },
    )
    limiter.init_app(app)

    # Import models so Flask-Migrate can see them for autogeneration.
    from app import models  # noqa: F401
