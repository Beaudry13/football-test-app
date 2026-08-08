"""Source-document upload, rendering, delivery and deletion.

These are the twelve things Milestone 1 exists to prove, exercised through the
real API rather than against the services directly.
"""

import io

import pytest
from reportlab.pdfgen import canvas as rl_canvas

from app.extensions import db
from app.models import DocumentPage, SourceDocument
from app.services.private_storage import get_private_storage


def make_pdf(pages: int = 2, size=(612, 792), name: str = "CROWN.pdf"):
    """A real, parseable PDF - the routes open it with PDFium, so placeholder
    bytes would be rejected long before reaching the code under test."""
    buffer = io.BytesIO()
    canvas = rl_canvas.Canvas(buffer, pagesize=size)
    for index in range(pages):
        canvas.setFont("Helvetica", 14)
        canvas.drawString(72, size[1] - 72, f"INSTALL {index + 1} - COVER 3")
        canvas.showPage()
    canvas.save()
    buffer.seek(0)
    return buffer, name


def upload(client, headers, **kwargs):
    buffer, name = make_pdf(**kwargs)
    return client.post(
        "/api/documents",
        headers=headers,
        data={"file": (buffer, name)},
        content_type="multipart/form-data",
    )


class TestUpload:
    def test_uploads_a_pdf_and_creates_a_page_per_page(self, client, coach_headers):
        response = upload(client, coach_headers, pages=3)
        assert response.status_code == 201, response.get_json()
        body = response.get_json()

        assert body["page_count"] == 3
        assert len(body["pages"]) == 3
        assert [p["page_number"] for p in body["pages"]] == [1, 2, 3]

    def test_titles_the_document_from_the_filename(self, client, coach_headers):
        body = upload(client, coach_headers, name="CROWN.pdf").get_json()
        assert body["title"] == "CROWN"

    def test_pins_page_dimensions_at_upload_not_at_first_open(self, client, coach_headers):
        # The coordinate space for page 3 must be fixed before anyone opens
        # it, so it cannot depend on when - or whether - they ever do.
        body = upload(client, coach_headers, pages=3).get_json()
        for page in body["pages"]:
            assert page["render_width"] == 1275
            assert page["render_height"] == 1651
            assert page["render_dpi"] == 150
            assert page["width_pt"] == 612
            assert page["height_pt"] == 792

    def test_thumbnails_exist_immediately_but_full_renders_do_not(self, client, coach_headers):
        # Tier 1 of the three-tier strategy: the page strip is usable at once,
        # and an unopened page of a 200-page playbook costs nothing.
        body = upload(client, coach_headers, pages=3).get_json()
        for page in body["pages"]:
            assert page["thumbnail_url"] is not None
            assert page["image_url"] is None
            assert page["has_full_render"] is False

    def test_reports_an_aspect_ratio_for_layout(self, client, coach_headers):
        page = upload(client, coach_headers).get_json()["pages"][0]
        assert page["aspect_ratio"] == pytest.approx(1275 / 1651, rel=1e-4)

    def test_records_provenance_and_hash(self, client, coach_headers, app):
        upload(client, coach_headers)
        with app.app_context():
            document = SourceDocument.query.one()
            assert len(document.content_hash) == 64
            assert document.byte_size > 0
            page = DocumentPage.query.first()
            assert page.renderer_version.startswith("pypdfium2/")

    def test_requires_authentication(self, client):
        buffer, name = make_pdf()
        response = client.post(
            "/api/documents",
            data={"file": (buffer, name)},
            content_type="multipart/form-data",
        )
        assert response.status_code == 401


class TestUploadValidation:
    def test_rejects_a_missing_file(self, client, coach_headers):
        response = client.post(
            "/api/documents", headers=coach_headers, data={}, content_type="multipart/form-data"
        )
        assert response.status_code == 400

    def test_rejects_a_non_pdf_even_when_named_pdf(self, client, coach_headers):
        # Identification is by magic bytes. The filename and the Content-Type
        # are both chosen by the client and prove nothing.
        response = client.post(
            "/api/documents",
            headers=coach_headers,
            data={"file": (io.BytesIO(b"\x89PNG\r\n\x1a\n" + b"0" * 200), "playbook.pdf")},
            content_type="multipart/form-data",
        )
        assert response.status_code == 422
        assert "PDF" in response.get_json()["error"]

    def test_rejects_a_truncated_pdf(self, client, coach_headers):
        buffer, _ = make_pdf()
        truncated = buffer.getvalue()[: len(buffer.getvalue()) // 3]
        response = client.post(
            "/api/documents",
            headers=coach_headers,
            data={"file": (io.BytesIO(truncated), "broken.pdf")},
            content_type="multipart/form-data",
        )
        assert response.status_code == 422

    def test_rejects_an_encrypted_pdf_with_a_useful_message(self, client, coach_headers):
        buffer = io.BytesIO()
        canvas = rl_canvas.Canvas(buffer, pagesize=(612, 792), encrypt="secret")
        canvas.drawString(72, 720, "protected")
        canvas.save()
        buffer.seek(0)
        response = client.post(
            "/api/documents",
            headers=coach_headers,
            data={"file": (buffer, "locked.pdf")},
            content_type="multipart/form-data",
        )
        assert response.status_code == 422
        # A coach who picked a password-protected file must be told that
        # specifically, not "the file is broken".
        assert "password" in response.get_json()["error"].lower()

    def test_rejects_an_empty_file(self, client, coach_headers):
        response = client.post(
            "/api/documents",
            headers=coach_headers,
            data={"file": (io.BytesIO(b""), "empty.pdf")},
            content_type="multipart/form-data",
        )
        assert response.status_code == 422

    def test_rejects_a_pathological_page_count(self, client, coach_headers, app):
        app.config["PDF_MAX_PAGES"] = 3
        try:
            response = upload(client, coach_headers, pages=5)
            assert response.status_code == 422
            assert "page" in response.get_json()["error"].lower()
        finally:
            app.config["PDF_MAX_PAGES"] = 400

    def test_page_limit_is_checked_before_anything_is_rendered(
        self, client, coach_headers, app
    ):
        # A decompression bomb must be refused, not rendered and then refused.
        app.config["PDF_MAX_PAGES"] = 2
        try:
            upload(client, coach_headers, pages=6)
            with app.app_context():
                assert SourceDocument.query.count() == 0
                assert DocumentPage.query.count() == 0
        finally:
            app.config["PDF_MAX_PAGES"] = 400

    def test_rejects_an_oversized_pdf(self, client, coach_headers, app):
        app.config["PDF_MAX_UPLOAD_BYTES"] = 512
        try:
            response = upload(client, coach_headers, pages=2)
            assert response.status_code == 413
        finally:
            app.config["PDF_MAX_UPLOAD_BYTES"] = 50 * 1024 * 1024

    def test_a_rejected_upload_leaves_no_rows(self, client, coach_headers, app):
        client.post(
            "/api/documents",
            headers=coach_headers,
            data={"file": (io.BytesIO(b"not a pdf at all"), "x.pdf")},
            content_type="multipart/form-data",
        )
        with app.app_context():
            assert SourceDocument.query.count() == 0


class TestFullPageRendering:
    def test_first_open_renders_and_subsequent_opens_reuse(self, client, coach_headers, app):
        document_id = upload(client, coach_headers, pages=2).get_json()["id"]

        first = client.get(f"/api/documents/{document_id}/pages/1", headers=coach_headers)
        assert first.status_code == 200
        assert first.get_json()["has_full_render"] is True
        assert first.get_json()["image_url"] is not None

        with app.app_context():
            page = DocumentPage.query.filter_by(page_number=1).one()
            key_after_first = page.image_key

        second = client.get(f"/api/documents/{document_id}/pages/1", headers=coach_headers)
        assert second.status_code == 200
        with app.app_context():
            # The row IS the cache: a second open must not produce a second
            # object in storage.
            assert DocumentPage.query.filter_by(page_number=1).one().image_key == key_after_first

    def test_opening_one_page_does_not_render_the_others(self, client, coach_headers, app):
        document_id = upload(client, coach_headers, pages=3).get_json()["id"]
        client.get(f"/api/documents/{document_id}/pages/2", headers=coach_headers)
        with app.app_context():
            rendered = [p.page_number for p in DocumentPage.query.all() if p.image_key]
            assert rendered == [2]

    def test_rendered_image_matches_the_pinned_coordinate_space(
        self, client, coach_headers, app
    ):
        # The contract from document_geometry.py, end to end: the bytes the
        # coach actually looks at must be exactly the size their regions will
        # be positioned against.
        from PIL import Image

        document_id = upload(client, coach_headers).get_json()["id"]
        client.get(f"/api/documents/{document_id}/pages/1", headers=coach_headers)
        with app.app_context():
            page = DocumentPage.query.filter_by(page_number=1).one()
            data = get_private_storage().load_private(page.image_key)
            image = Image.open(io.BytesIO(data))
            assert (image.width, image.height) == (page.render_width, page.render_height)

    def test_unknown_page_is_404(self, client, coach_headers):
        document_id = upload(client, coach_headers, pages=2).get_json()["id"]
        assert (
            client.get(f"/api/documents/{document_id}/pages/9", headers=coach_headers).status_code
            == 404
        )


class TestMediaDelivery:
    def test_a_signed_thumbnail_url_serves_an_image(self, client, coach_headers):
        page = upload(client, coach_headers).get_json()["pages"][0]
        response = client.get(page["thumbnail_url"])
        assert response.status_code == 200
        assert response.mimetype == "image/webp"

    def test_media_needs_no_jwt(self, client, coach_headers):
        # By design: a player has no credential, and an <img> cannot send one.
        page = upload(client, coach_headers).get_json()["pages"][0]
        assert client.get(page["thumbnail_url"], headers={}).status_code == 200

    def test_cache_lifetime_never_outlives_the_token(self, client, coach_headers, app):
        page = upload(client, coach_headers).get_json()["pages"][0]
        response = client.get(page["thumbnail_url"])
        cache_control = response.headers["Cache-Control"]
        assert cache_control.startswith("private,")
        max_age = int(cache_control.split("max-age=")[1])
        assert 0 < max_age <= app.config["SIGNED_MEDIA_TTL_SECONDS"]

    def test_an_invalid_token_is_404_not_403(self, client):
        # Every failure mode looks identical from outside, so a forged token
        # cannot be tuned by watching which error comes back.
        assert client.get("/api/media/v1.bogus.signature").status_code == 404
        assert client.get("/api/media/garbage").status_code == 404

    def test_an_expired_token_is_404(self, client, coach_headers, app):
        from app.services.signed_media import KIND_THUMBNAIL, sign_media_token

        upload(client, coach_headers)
        with app.app_context():
            page = DocumentPage.query.first()
            token = sign_media_token(KIND_THUMBNAIL, page.id, ttl_seconds=-1)
        assert client.get(f"/api/media/{token}").status_code == 404

    def test_a_page_token_cannot_read_an_unrendered_page(self, client, coach_headers, app):
        from app.services.signed_media import KIND_PAGE, sign_media_token

        upload(client, coach_headers)
        with app.app_context():
            page = DocumentPage.query.first()
            token = sign_media_token(KIND_PAGE, page.id)
        assert client.get(f"/api/media/{token}").status_code == 404


class TestTheSourcePdfIsUnreachable:
    """Requirement 9, from the outside."""

    def test_no_response_ever_contains_the_storage_key(self, client, coach_headers, app):
        body = upload(client, coach_headers, pages=2).get_json()
        with app.app_context():
            key = SourceDocument.query.one().storage_key
        serialised = str(body)
        assert key not in serialised
        assert "storage_key" not in serialised

        listing = str(client.get("/api/documents", headers=coach_headers).get_json())
        detail = str(
            client.get(f"/api/documents/{body['id']}", headers=coach_headers).get_json()
        )
        assert key not in listing and key not in detail

    def test_the_pdf_is_not_served_by_the_uploads_route(self, client, coach_headers, app):
        upload(client, coach_headers)
        with app.app_context():
            key = SourceDocument.query.one().storage_key
        assert client.get(f"/uploads/{key}").status_code == 404

    def test_no_media_token_can_be_minted_for_the_pdf(self, client, coach_headers, app):
        # Even holding a valid coach session, there is no way to ask for one.
        from app.services.signed_media import sign_media_token

        upload(client, coach_headers)
        with app.app_context():
            with pytest.raises(ValueError):
                sign_media_token("pdf", 1)

    def test_a_page_token_serves_an_image_not_the_pdf(self, client, coach_headers):
        document_id = upload(client, coach_headers).get_json()["id"]
        page = client.get(
            f"/api/documents/{document_id}/pages/1", headers=coach_headers
        ).get_json()
        body = client.get(page["image_url"]).data
        assert not body.startswith(b"%PDF-")
        assert body[:4] == b"RIFF"  # WebP


class TestTenancy:
    def test_another_organization_cannot_see_the_document(self, client, register_coach):
        _, _, owner = register_coach(username="owner", email="owner@example.com")
        document_id = upload(client, owner).get_json()["id"]

        _, _, outsider = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        # 404, never 403: an id must not be probeable for existence.
        assert client.get(f"/api/documents/{document_id}", headers=outsider).status_code == 404
        assert (
            client.get(f"/api/documents/{document_id}/pages/1", headers=outsider).status_code
            == 404
        )
        assert client.delete(f"/api/documents/{document_id}", headers=outsider).status_code == 404

    def test_listing_shows_only_your_organizations_documents(self, client, register_coach):
        _, _, owner = register_coach(username="owner", email="owner@example.com")
        upload(client, owner)

        _, _, outsider = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        assert client.get("/api/documents", headers=outsider).get_json() == []
        assert len(client.get("/api/documents", headers=owner).get_json()) == 1

    def test_a_teammate_can_use_a_document_they_did_not_upload(
        self, client, register_coach, invite_teammate
    ):
        # A playbook is team infrastructure - it must outlive the coach who
        # uploaded it and be usable by assistants.
        _, _, admin = register_coach()
        document_id = upload(client, admin).get_json()["id"]
        _, _, teammate = invite_teammate(admin)
        assert client.get(f"/api/documents/{document_id}", headers=teammate).status_code == 200


class TestDeletion:
    def test_deletes_rows_and_every_private_asset(self, client, coach_headers, app):
        document_id = upload(client, coach_headers, pages=2).get_json()["id"]
        client.get(f"/api/documents/{document_id}/pages/1", headers=coach_headers)

        with app.app_context():
            document = SourceDocument.query.one()
            keys = [document.storage_key] + [
                key
                for page in document.pages
                for key in (page.image_key, page.thumbnail_key)
                if key
            ]
        assert len(keys) == 4  # pdf + 2 thumbnails + 1 rendered page

        assert client.delete(f"/api/documents/{document_id}", headers=coach_headers).status_code == 204

        with app.app_context():
            assert SourceDocument.query.count() == 0
            assert DocumentPage.query.count() == 0
            storage = get_private_storage()
            for key in keys:
                assert storage.load_private(key) is None, f"{key} survived deletion"

    def test_previously_issued_media_urls_stop_working(self, client, coach_headers):
        document_id = upload(client, coach_headers).get_json()["id"]
        page = client.get(
            f"/api/documents/{document_id}/pages/1", headers=coach_headers
        ).get_json()
        assert client.get(page["image_url"]).status_code == 200

        client.delete(f"/api/documents/{document_id}", headers=coach_headers)
        assert client.get(page["image_url"]).status_code == 404

    def test_deleting_an_unknown_document_is_404(self, client, coach_headers):
        assert client.delete("/api/documents/99999", headers=coach_headers).status_code == 404


class TestTitleEditing:
    def test_a_coach_can_rename_a_document(self, client, coach_headers):
        document_id = upload(client, coach_headers).get_json()["id"]
        response = client.patch(
            f"/api/documents/{document_id}",
            headers=coach_headers,
            json={"title": "2026 Defense - Install 1"},
        )
        assert response.status_code == 200
        assert response.get_json()["title"] == "2026 Defense - Install 1"

    def test_rejects_an_empty_title(self, client, coach_headers):
        document_id = upload(client, coach_headers).get_json()["id"]
        response = client.patch(
            f"/api/documents/{document_id}", headers=coach_headers, json={"title": ""}
        )
        assert response.status_code == 422


class TestTextRunDetection:
    """Tap-to-select's data source. Not OCR - this reads the text layer that
    is already inside the PDF, which is why it needs no model and cannot be
    'wrong' about what a word says."""

    def test_returns_runs_with_their_text(self, client, coach_headers):
        document_id = upload(client, coach_headers).get_json()["id"]
        response = client.get(
            f"/api/documents/{document_id}/pages/1/text-runs", headers=coach_headers
        )
        assert response.status_code == 200
        runs = response.get_json()["runs"]
        assert any("COVER 3" in run["text"] for run in runs), [r["text"] for r in runs]

    def test_coordinates_are_normalised_with_a_top_left_origin(self, client, coach_headers):
        # PDF user space has its origin at the BOTTOM-left; every client
        # coordinate here has it at the top-left. Getting that backwards puts
        # every mask on the wrong end of the page.
        document_id = upload(client, coach_headers).get_json()["id"]
        runs = client.get(
            f"/api/documents/{document_id}/pages/1/text-runs", headers=coach_headers
        ).get_json()["runs"]

        for run in runs:
            assert 0.0 <= run["x"] <= 1.0
            assert 0.0 <= run["y"] <= 1.0
            assert 0.0 < run["width"] <= 1.0
            assert 0.0 < run["height"] <= 1.0

        # make_pdf draws its text near the TOP of the page, so y must be small.
        top = min(run["y"] for run in runs)
        assert top < 0.3, f"text drawn at the top should have a small y, got {top}"

    def test_a_page_with_no_text_returns_an_empty_list(self, client, coach_headers):
        import io as _io

        from reportlab.pdfgen import canvas as rl_canvas

        buffer = _io.BytesIO()
        canvas = rl_canvas.Canvas(buffer, pagesize=(612, 792))
        canvas.circle(300, 400, 50)  # a shape, no text
        canvas.showPage()
        canvas.save()
        buffer.seek(0)

        document_id = client.post(
            "/api/documents",
            headers=coach_headers,
            data={"file": (buffer, "shapes.pdf")},
            content_type="multipart/form-data",
        ).get_json()["id"]

        response = client.get(
            f"/api/documents/{document_id}/pages/1/text-runs", headers=coach_headers
        )
        # An empty list is a valid answer, not an error - it is what a scanned
        # playbook returns, and the editor must work identically with it.
        assert response.status_code == 200
        assert response.get_json()["runs"] == []

    def test_another_organization_cannot_read_the_text_layer(self, client, register_coach):
        _, _, owner = register_coach(username="owner", email="owner@example.com")
        document_id = upload(client, owner).get_json()["id"]

        _, _, rival = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        # The text layer is the playbook's contents in machine-readable form -
        # if anything must not leak across organizations, it is this.
        assert (
            client.get(
                f"/api/documents/{document_id}/pages/1/text-runs", headers=rival
            ).status_code
            == 404
        )

    def test_requires_authentication(self, client, coach_headers):
        document_id = upload(client, coach_headers).get_json()["id"]
        assert client.get(f"/api/documents/{document_id}/pages/1/text-runs").status_code == 401
