"""Private asset storage, and the boundary that makes it private."""

from pathlib import Path

import pytest

from app.services.private_storage import (
    LocalPrivateStorage,
    get_private_storage,
    new_storage_key,
)


class TestStorageKeys:
    def test_keys_are_unguessable(self):
        # 32 bytes of entropy, hex-encoded, plus an extension.
        key = new_storage_key("pdf")
        stem = key.rsplit(".", 1)[0]
        assert len(stem) == 64
        assert all(c in "0123456789abcdef" for c in stem)

    def test_keys_are_unique(self):
        assert len({new_storage_key("pdf") for _ in range(500)}) == 500

    def test_key_carries_no_information_about_the_file(self):
        # Nothing about the org, the coach, the filename or an id may appear
        # in a key: a guessable key is the only thing standing between an
        # attacker and a playbook if a bucket is ever misconfigured.
        first = new_storage_key("pdf")
        second = new_storage_key("pdf")
        assert first.rsplit(".", 1)[0] != second.rsplit(".", 1)[0]

    def test_extension_is_sanitised(self):
        key = new_storage_key("../../etc/passwd")
        assert "/" not in key and ".." not in key.rsplit(".", 1)[0]


class TestLocalPrivateStorage:
    def test_round_trips_bytes_unchanged(self, tmp_path):
        storage = LocalPrivateStorage(str(tmp_path))
        payload = b"%PDF-1.7\nnot really a pdf\x00\xff"
        key = storage.save_private(payload, content_type="application/pdf", extension="pdf")
        assert storage.load_private(key) == payload

    def test_missing_key_returns_none_rather_than_raising(self, tmp_path):
        storage = LocalPrivateStorage(str(tmp_path))
        assert storage.load_private(new_storage_key("pdf")) is None

    def test_delete_removes_the_asset(self, tmp_path):
        storage = LocalPrivateStorage(str(tmp_path))
        key = storage.save_private(b"data", content_type="application/pdf", extension="pdf")
        storage.delete_private(key)
        assert storage.load_private(key) is None

    def test_delete_is_idempotent(self, tmp_path):
        storage = LocalPrivateStorage(str(tmp_path))
        key = storage.save_private(b"data", content_type="application/pdf", extension="pdf")
        storage.delete_private(key)
        storage.delete_private(key)  # must not raise

    @pytest.mark.parametrize(
        "hostile", ["../escape.pdf", "../../etc/passwd", "sub/dir.pdf", "/absolute.pdf"]
    )
    def test_refuses_keys_that_escape_the_folder(self, tmp_path, hostile):
        storage = LocalPrivateStorage(str(tmp_path))
        # Reads and deletes swallow it; the point is that nothing outside the
        # folder is ever touched.
        assert storage.load_private(hostile) is None
        storage.delete_private(hostile)


class TestPrivateFolderIsNotServed:
    """The single most important property in Milestone 1's storage layer.

    create_app serves UPLOAD_FOLDER wholesale at /uploads/<path:filename>. If
    the private folder were inside it, every playbook would be one URL away
    from anyone at all.
    """

    def test_private_folder_is_outside_the_served_upload_folder(self, app):
        served = Path(app.config["UPLOAD_FOLDER"]).resolve()
        private = Path(app.config["PRIVATE_UPLOAD_FOLDER"]).resolve()
        assert private != served
        assert served not in private.parents, (
            f"PRIVATE_UPLOAD_FOLDER ({private}) is inside UPLOAD_FOLDER ({served}), "
            "which create_app serves at /uploads/<path>. Private documents would "
            "be publicly downloadable."
        )

    def test_a_private_asset_is_not_reachable_through_the_uploads_route(self, app, client):
        with app.app_context():
            storage = get_private_storage()
            key = storage.save_private(
                b"%PDF-1.7 secret playbook", content_type="application/pdf", extension="pdf"
            )
        response = client.get(f"/uploads/{key}")
        assert response.status_code == 404
