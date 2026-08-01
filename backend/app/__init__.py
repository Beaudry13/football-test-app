"""Application factory."""

import os

from flask import Flask, jsonify, send_from_directory

from app.config import get_config
from app.errors import register_error_handlers
from app.extensions import bcrypt, cors, db, jwt, migrate


def create_app(env_name: str | None = None) -> Flask:
    app = Flask(__name__)
    app.config.from_object(get_config(env_name))

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


def _init_extensions(app: Flask) -> None:
    db.init_app(app)
    migrate.init_app(app, db)
    bcrypt.init_app(app)
    jwt.init_app(app)
    cors.init_app(app, resources={r"/api/*": {"origins": app.config["CORS_ORIGINS"]}})

    # Import models so Flask-Migrate can see them for autogeneration.
    from app import models  # noqa: F401
