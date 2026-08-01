"""Helpers for validating request payloads with marshmallow schemas."""

from flask import request
from marshmallow import Schema, ValidationError

from app.errors import ApiError


def load_json_body(schema: Schema) -> dict:
    payload = request.get_json(silent=True)
    if payload is None:
        raise ApiError("Request body must be valid JSON", status_code=400)

    try:
        return schema.load(payload)
    except ValidationError as exc:
        raise ApiError("Validation failed", status_code=422, details=exc.messages) from exc


def load_optional_json_body(schema: Schema) -> dict:
    """Like `load_json_body`, but a request sent with no body at all (rather
    than invalid JSON) is treated as `{}` instead of a 400 - for endpoints
    where every field is optional and a caller with nothing to say
    shouldn't have to send an empty JSON object just to avoid an error."""
    payload = request.get_json(silent=True) or {}

    try:
        return schema.load(payload)
    except ValidationError as exc:
        raise ApiError("Validation failed", status_code=422, details=exc.messages) from exc
