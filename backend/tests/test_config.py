"""Startup config safety: unknown FLASK_ENV values and production secret
validation (PEIRA-002, PEIRA-003) - both must fail loudly at boot rather
than silently falling back to insecure/wrong settings."""

import pytest

from app import create_app
from app.config import (
    DEV_JWT_SECRET_KEY_DEFAULT,
    DEV_SECRET_KEY_DEFAULT,
    DevelopmentConfig,
    ProductionConfig,
    TestingConfig,
    get_config,
)

FAKE_DATABASE_URL = "postgresql://user:pass@localhost:5432/fakedb"


def test_get_config_returns_expected_class_for_each_known_name():
    assert get_config("development") is DevelopmentConfig
    assert get_config("testing") is TestingConfig
    assert get_config("production") is ProductionConfig


def test_get_config_rejects_unknown_environment_name():
    with pytest.raises(RuntimeError, match="Unknown FLASK_ENV"):
        get_config("prodution")


def test_create_app_rejects_unknown_environment_name():
    with pytest.raises(RuntimeError, match="Unknown FLASK_ENV"):
        create_app("prodution")


def test_production_starts_with_valid_secrets_and_database(monkeypatch):
    monkeypatch.setattr(ProductionConfig, "SECRET_KEY", "a-real-production-secret-key-value")
    monkeypatch.setattr(ProductionConfig, "JWT_SECRET_KEY", "a-real-production-jwt-secret-value")
    monkeypatch.setattr(ProductionConfig, "SQLALCHEMY_DATABASE_URI", FAKE_DATABASE_URL)

    app = create_app("production")

    assert app.config["SECRET_KEY"] == "a-real-production-secret-key-value"


def test_production_fails_without_secret_key(monkeypatch):
    monkeypatch.setattr(ProductionConfig, "SECRET_KEY", None)
    monkeypatch.setattr(ProductionConfig, "JWT_SECRET_KEY", "a-real-production-jwt-secret-value")
    monkeypatch.setattr(ProductionConfig, "SQLALCHEMY_DATABASE_URI", FAKE_DATABASE_URL)

    with pytest.raises(RuntimeError, match="SECRET_KEY is not set"):
        create_app("production")


def test_production_fails_with_default_secret_key(monkeypatch):
    monkeypatch.setattr(ProductionConfig, "SECRET_KEY", DEV_SECRET_KEY_DEFAULT)
    monkeypatch.setattr(ProductionConfig, "JWT_SECRET_KEY", "a-real-production-jwt-secret-value")
    monkeypatch.setattr(ProductionConfig, "SQLALCHEMY_DATABASE_URI", FAKE_DATABASE_URL)

    with pytest.raises(RuntimeError, match="SECRET_KEY is still the public dev default"):
        create_app("production")


def test_production_fails_without_jwt_secret_key(monkeypatch):
    monkeypatch.setattr(ProductionConfig, "SECRET_KEY", "a-real-production-secret-key-value")
    monkeypatch.setattr(ProductionConfig, "JWT_SECRET_KEY", None)
    monkeypatch.setattr(ProductionConfig, "SQLALCHEMY_DATABASE_URI", FAKE_DATABASE_URL)

    with pytest.raises(RuntimeError, match="JWT_SECRET_KEY is not set"):
        create_app("production")


def test_production_fails_with_default_jwt_secret_key(monkeypatch):
    monkeypatch.setattr(ProductionConfig, "SECRET_KEY", "a-real-production-secret-key-value")
    monkeypatch.setattr(ProductionConfig, "JWT_SECRET_KEY", DEV_JWT_SECRET_KEY_DEFAULT)
    monkeypatch.setattr(ProductionConfig, "SQLALCHEMY_DATABASE_URI", FAKE_DATABASE_URL)

    with pytest.raises(RuntimeError, match="JWT_SECRET_KEY is still the public dev default"):
        create_app("production")


def test_production_fails_without_database_url(monkeypatch):
    monkeypatch.setattr(ProductionConfig, "SECRET_KEY", "a-real-production-secret-key-value")
    monkeypatch.setattr(ProductionConfig, "JWT_SECRET_KEY", "a-real-production-jwt-secret-value")
    monkeypatch.setattr(ProductionConfig, "SQLALCHEMY_DATABASE_URI", None)

    with pytest.raises(RuntimeError, match="DATABASE_URL is not set"):
        create_app("production")


def test_production_reports_every_problem_at_once(monkeypatch):
    monkeypatch.setattr(ProductionConfig, "SECRET_KEY", None)
    monkeypatch.setattr(ProductionConfig, "JWT_SECRET_KEY", None)
    monkeypatch.setattr(ProductionConfig, "SQLALCHEMY_DATABASE_URI", None)

    with pytest.raises(RuntimeError) as exc_info:
        create_app("production")

    message = str(exc_info.value)
    assert "SECRET_KEY is not set" in message
    assert "JWT_SECRET_KEY is not set" in message
    assert "DATABASE_URL is not set" in message


def test_development_and_testing_are_not_subject_to_production_secret_checks():
    # Local dev convenience must survive this change: neither environment
    # sets real secrets or a real database URL in this test run, and both
    # must still boot fine - only "production" is gated.
    create_app("development")
    create_app("testing")
