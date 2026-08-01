"""S3FileStorage in isolation - no Flask app/db needed, just boto3 mocked out."""

from io import BytesIO
from unittest.mock import MagicMock

import pytest
from werkzeug.datastructures import FileStorage as UploadedFile

from app import create_app
from app.config import TestingConfig
from app.errors import ApiError
from app.services.file_storage import S3FileStorage

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}


def make_storage(monkeypatch) -> tuple[S3FileStorage, MagicMock]:
    fake_client = MagicMock()
    monkeypatch.setattr("app.services.file_storage.boto3.client", lambda *args, **kwargs: fake_client)
    storage = S3FileStorage(
        allowed_extensions=ALLOWED_EXTENSIONS,
        account_id="test-account",
        access_key_id="test-key",
        secret_access_key="test-secret",
        bucket_name="quiz-images",
        public_url_base="https://pub-abc123.r2.dev/",
    )
    return storage, fake_client


def test_save_image_uploads_to_bucket_and_returns_its_public_url(monkeypatch):
    storage, fake_client = make_storage(monkeypatch)
    uploaded = UploadedFile(stream=BytesIO(b"fake-image-bytes"), filename="play.png", content_type="image/png")

    url = storage.save_image(uploaded)

    fake_client.put_object.assert_called_once()
    call_kwargs = fake_client.put_object.call_args.kwargs
    assert call_kwargs["Bucket"] == "quiz-images"
    assert call_kwargs["ContentType"] == "image/png"
    assert call_kwargs["Key"].endswith(".png")
    assert url == f"https://pub-abc123.r2.dev/{call_kwargs['Key']}"


def test_save_image_guesses_content_type_when_not_provided(monkeypatch):
    storage, fake_client = make_storage(monkeypatch)
    uploaded = UploadedFile(stream=BytesIO(b"fake-image-bytes"), filename="play.jpg")

    storage.save_image(uploaded)

    assert fake_client.put_object.call_args.kwargs["ContentType"] == "image/jpeg"


def test_save_image_rejects_disallowed_extension_without_touching_the_bucket(monkeypatch):
    storage, fake_client = make_storage(monkeypatch)
    uploaded = UploadedFile(stream=BytesIO(b"not an image"), filename="malware.exe", content_type="application/octet-stream")

    with pytest.raises(ApiError) as exc_info:
        storage.save_image(uploaded)

    assert exc_info.value.status_code == 400
    fake_client.put_object.assert_not_called()


def test_delete_image_deletes_by_key_parsed_from_the_url(monkeypatch):
    storage, fake_client = make_storage(monkeypatch)

    storage.delete_image("https://pub-abc123.r2.dev/deadbeef1234.png")

    fake_client.delete_object.assert_called_once_with(Bucket="quiz-images", Key="deadbeef1234.png")


def test_create_app_fails_fast_when_s3_backend_is_missing_required_config(monkeypatch):
    monkeypatch.setattr(TestingConfig, "STORAGE_BACKEND", "s3")

    with pytest.raises(RuntimeError, match="STORAGE_BACKEND=s3"):
        create_app("testing")
