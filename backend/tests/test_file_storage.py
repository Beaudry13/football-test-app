"""S3FileStorage and LocalFileStorage - image compression, resizing, and
validation, all independent of any Flask app/db (boto3 mocked out for S3)."""

import io
from unittest.mock import MagicMock

import pytest
from PIL import Image
from werkzeug.datastructures import FileStorage as UploadedFile

from app import create_app
from app.config import TestingConfig
from app.errors import ApiError
from app.services.file_storage import LocalFileStorage, S3FileStorage

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}
DEFAULT_MAX_DIMENSION = 2400
DEFAULT_QUALITY = 88


def make_png_bytes(size: tuple[int, int] = (20, 20), color=(0, 128, 255)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color=color).save(buffer, format="PNG")
    return buffer.getvalue()


def make_rotated_jpeg_bytes(size: tuple[int, int] = (40, 20), orientation: int = 6) -> bytes:
    """A JPEG whose EXIF Orientation tag says "rotate me" (6 = 90deg CW),
    with its pixel data stored *unrotated* - exactly what a phone camera
    produces. size is (width, height) as EXIF-tagged; the raw stored pixels
    are the untransposed dimensions."""
    image = Image.new("RGB", size, color=(255, 0, 0))
    # Mark one corner distinctly so orientation-correction is verifiable by
    # pixel, not just by width/height swapping.
    image.putpixel((0, 0), (0, 255, 0))

    exif = image.getexif()
    exif[0x0112] = orientation  # Orientation tag
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", exif=exif)
    return buffer.getvalue()


def make_storage(monkeypatch, max_dimension: int = DEFAULT_MAX_DIMENSION, quality: int = DEFAULT_QUALITY):
    fake_client = MagicMock()
    monkeypatch.setattr("app.services.file_storage.boto3.client", lambda *args, **kwargs: fake_client)
    storage = S3FileStorage(
        allowed_extensions=ALLOWED_EXTENSIONS,
        account_id="test-account",
        access_key_id="test-key",
        secret_access_key="test-secret",
        bucket_name="quiz-images",
        public_url_base="https://pub-abc123.r2.dev/",
        max_dimension=max_dimension,
        jpeg_quality=quality,
    )
    return storage, fake_client


def test_save_image_uploads_to_bucket_and_returns_its_public_url(monkeypatch):
    storage, fake_client = make_storage(monkeypatch)
    uploaded = UploadedFile(stream=io.BytesIO(make_png_bytes()), filename="play.png", content_type="image/png")

    url = storage.save_image(uploaded)

    fake_client.put_object.assert_called_once()
    call_kwargs = fake_client.put_object.call_args.kwargs
    assert call_kwargs["Bucket"] == "quiz-images"
    assert call_kwargs["Key"].endswith(".jpg")
    assert url == f"https://pub-abc123.r2.dev/{call_kwargs['Key']}"


def test_save_image_normalizes_png_to_jpeg(monkeypatch):
    """Every accepted format is recompressed to JPEG, regardless of what was
    uploaded - PNG's content type/extension must not survive."""
    storage, fake_client = make_storage(monkeypatch)
    uploaded = UploadedFile(stream=io.BytesIO(make_png_bytes()), filename="play.png", content_type="image/png")

    storage.save_image(uploaded)

    call_kwargs = fake_client.put_object.call_args.kwargs
    assert call_kwargs["ContentType"] == "image/jpeg"
    assert call_kwargs["Key"].endswith(".jpg")
    # The bytes actually sent decode as a real JPEG.
    stored = Image.open(io.BytesIO(call_kwargs["Body"]))
    assert stored.format == "JPEG"


def test_save_image_uses_jpeg_content_type_even_when_none_is_provided(monkeypatch):
    storage, fake_client = make_storage(monkeypatch)
    uploaded = UploadedFile(stream=io.BytesIO(make_png_bytes()), filename="play.jpg")

    storage.save_image(uploaded)

    assert fake_client.put_object.call_args.kwargs["ContentType"] == "image/jpeg"


def test_save_image_rejects_disallowed_extension_without_touching_the_bucket(monkeypatch):
    storage, fake_client = make_storage(monkeypatch)
    uploaded = UploadedFile(
        stream=io.BytesIO(b"not an image"), filename="malware.exe", content_type="application/octet-stream"
    )

    with pytest.raises(ApiError) as exc_info:
        storage.save_image(uploaded)

    assert exc_info.value.status_code == 400
    fake_client.put_object.assert_not_called()


def test_save_image_rejects_corrupt_image_file(monkeypatch):
    """Garbage bytes under an otherwise-allowed extension must produce a
    clean 400, not a raw Pillow exception surfacing as a 500."""
    storage, fake_client = make_storage(monkeypatch)
    uploaded = UploadedFile(
        stream=io.BytesIO(b"this is not actually png data"), filename="corrupt.png", content_type="image/png"
    )

    with pytest.raises(ApiError) as exc_info:
        storage.save_image(uploaded)

    assert exc_info.value.status_code == 400
    assert "valid image" in exc_info.value.message
    fake_client.put_object.assert_not_called()


def test_save_image_resizes_oversized_image(monkeypatch):
    storage, fake_client = make_storage(monkeypatch, max_dimension=100)
    uploaded = UploadedFile(
        stream=io.BytesIO(make_png_bytes(size=(4000, 3000))), filename="huge.png", content_type="image/png"
    )

    storage.save_image(uploaded)

    stored = Image.open(io.BytesIO(fake_client.put_object.call_args.kwargs["Body"]))
    assert max(stored.width, stored.height) <= 100
    # Aspect ratio preserved (4000x3000 = 4:3).
    assert stored.width == 100
    assert stored.height == 75


def test_save_image_leaves_a_smaller_image_at_its_original_size(monkeypatch):
    storage, fake_client = make_storage(monkeypatch, max_dimension=2400)
    uploaded = UploadedFile(
        stream=io.BytesIO(make_png_bytes(size=(200, 150))), filename="small.png", content_type="image/png"
    )

    storage.save_image(uploaded)

    stored = Image.open(io.BytesIO(fake_client.put_object.call_args.kwargs["Body"]))
    assert (stored.width, stored.height) == (200, 150)


def test_save_image_corrects_exif_orientation(monkeypatch):
    storage, fake_client = make_storage(monkeypatch)
    uploaded = UploadedFile(
        stream=io.BytesIO(make_rotated_jpeg_bytes()), filename="phone-photo.jpg", content_type="image/jpeg"
    )

    storage.save_image(uploaded)

    stored = Image.open(io.BytesIO(fake_client.put_object.call_args.kwargs["Body"]))
    # Orientation 6 = rotate 90deg CW to display correctly; a 40x20 source
    # becomes 20x40 once the rotation is actually applied to the pixels
    # (rather than left as a passthrough tag the frontend doesn't read).
    assert (stored.width, stored.height) == (20, 40)
    # No EXIF orientation tag should remain in the (re-encoded) output -
    # it's already been baked into the pixels.
    exif = stored.getexif()
    assert exif.get(0x0112) in (None, 1)


def test_delete_image_deletes_by_key_parsed_from_the_url(monkeypatch):
    storage, fake_client = make_storage(monkeypatch)

    storage.delete_image("https://pub-abc123.r2.dev/deadbeef1234.jpg")

    fake_client.delete_object.assert_called_once_with(Bucket="quiz-images", Key="deadbeef1234.jpg")


def test_create_app_fails_fast_when_s3_backend_is_missing_required_config(monkeypatch):
    monkeypatch.setattr(TestingConfig, "STORAGE_BACKEND", "s3")

    with pytest.raises(RuntimeError, match="STORAGE_BACKEND=s3"):
        create_app("testing")


# --- LocalFileStorage: same compression behavior, disk-backed instead of S3 ---


def make_local_storage(tmp_path, max_dimension: int = DEFAULT_MAX_DIMENSION, quality: int = DEFAULT_QUALITY):
    return LocalFileStorage(
        upload_folder=str(tmp_path),
        allowed_extensions=ALLOWED_EXTENSIONS,
        max_dimension=max_dimension,
        jpeg_quality=quality,
    )


def test_local_save_image_writes_a_compressed_jpeg_to_disk(tmp_path):
    storage = make_local_storage(tmp_path)
    uploaded = UploadedFile(stream=io.BytesIO(make_png_bytes()), filename="play.png", content_type="image/png")

    url = storage.save_image(uploaded)

    assert url.startswith("/uploads/")
    assert url.endswith(".jpg")
    stored_path = tmp_path / url.rsplit("/", 1)[-1]
    assert stored_path.exists()
    assert Image.open(stored_path).format == "JPEG"


def test_local_save_image_rejects_corrupt_image_file(tmp_path):
    storage = make_local_storage(tmp_path)
    uploaded = UploadedFile(
        stream=io.BytesIO(b"garbage"), filename="corrupt.png", content_type="image/png"
    )

    with pytest.raises(ApiError) as exc_info:
        storage.save_image(uploaded)

    assert exc_info.value.status_code == 400
    assert list(tmp_path.iterdir()) == []


def test_local_save_image_resizes_oversized_image(tmp_path):
    storage = make_local_storage(tmp_path, max_dimension=100)
    uploaded = UploadedFile(
        stream=io.BytesIO(make_png_bytes(size=(4000, 2000))), filename="huge.png", content_type="image/png"
    )

    url = storage.save_image(uploaded)

    stored = Image.open(tmp_path / url.rsplit("/", 1)[-1])
    assert max(stored.width, stored.height) <= 100


def test_local_delete_image_removes_the_file(tmp_path):
    storage = make_local_storage(tmp_path)
    uploaded = UploadedFile(stream=io.BytesIO(make_png_bytes()), filename="play.png", content_type="image/png")
    url = storage.save_image(uploaded)

    storage.delete_image(url)

    assert list(tmp_path.iterdir()) == []
