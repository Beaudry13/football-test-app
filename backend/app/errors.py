"""Centralized error handling.

Routes raise ApiError for expected, client-facing failures (bad input,
not found, unauthorized). Anything else is caught by the generic
handlers below and turned into a consistent JSON error shape.
"""

from flask import Flask, jsonify
from werkzeug.exceptions import HTTPException


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

    @app.errorhandler(HTTPException)
    def handle_http_exception(error: HTTPException):
        return jsonify({"error": error.description}), error.code

    @app.errorhandler(Exception)
    def handle_unexpected_error(error: Exception):
        app.logger.exception("Unhandled exception")
        return jsonify({"error": "Internal server error"}), 500
