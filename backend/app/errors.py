"""Centralized error handling.

Routes raise ApiError for expected, client-facing failures (bad input,
not found, unauthorized). Anything else is caught by the generic
handlers below and turned into a consistent JSON error shape.
"""

from flask import Flask, current_app, jsonify
from flask_limiter.errors import RateLimitExceeded
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge


class ApiError(Exception):
    """An expected error that should be surfaced to the API client as-is."""

    def __init__(self, message: str, status_code: int = 400, details: dict | None = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.details = details or {}

    def to_dict(self) -> dict:
        payload = {"error": self.message}
        if self.details:
            payload["details"] = self.details
        return payload


def register_error_handlers(app: Flask) -> None:
    @app.errorhandler(ApiError)
    def handle_api_error(error: ApiError):
        return jsonify(error.to_dict()), error.status_code

    @app.errorhandler(RequestEntityTooLarge)
    def handle_too_large(error: RequestEntityTooLarge):
        max_mb = current_app.config["MAX_CONTENT_LENGTH"] // (1024 * 1024)
        return jsonify({"error": f"File is too large. Maximum size is {max_mb}MB."}), 413

    @app.errorhandler(RateLimitExceeded)
    def handle_rate_limit_exceeded(error: RateLimitExceeded):
        # Without this, the default description is Flask-Limiter's internal
        # limit string (e.g. "10 per 1 minute"), not something a user should
        # have to parse to understand what happened.
        return jsonify({"error": "Too many requests. Please wait a moment and try again."}), 429

    @app.errorhandler(HTTPException)
    def handle_http_exception(error: HTTPException):
        return jsonify({"error": error.description}), error.code

    @app.errorhandler(Exception)
    def handle_unexpected_error(error: Exception):
        app.logger.exception("Unhandled exception")
        return jsonify({"error": "Internal server error"}), 500
