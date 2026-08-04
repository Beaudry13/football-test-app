"""Master-roster CSV/pasted-spreadsheet import: preview + confirm."""


def preview(client, headers, raw_text, column_mapping=None):
    payload = {"raw_text": raw_text}
    if column_mapping is not None:
        payload["column_mapping"] = column_mapping
    return client.post("/api/players/import/preview", json=payload, headers=headers)


def confirm(client, headers, rows):
    return client.post("/api/players/import/confirm", json={"rows": rows}, headers=headers)


CSV_SAMPLE = "First Name,Last Name,Jersey Number,Position\nChris,Smith,2,WR\nJordan,Lee,15,DB\n"


def test_valid_csv_preview_is_not_written_to_db(client, coach_headers):
    response = preview(client, coach_headers, CSV_SAMPLE)
    assert response.status_code == 200
    body = response.get_json()
    assert body["total_rows"] == 2
    assert body["valid_count"] == 2
    assert body["invalid_count"] == 0
    assert [r["first_name"] for r in body["rows"]] == ["Chris", "Jordan"]

    # Nothing was actually created.
    assert client.get("/api/players", headers=coach_headers).get_json() == []


def test_pasted_spreadsheet_tsv_is_parsed(client, coach_headers):
    pasted = "First Name\tLast Name\tJersey Number\tPosition\nChris\tSmith\t2\tWR\n"
    response = preview(client, coach_headers, pasted)
    assert response.status_code == 200
    body = response.get_json()
    assert body["valid_count"] == 1
    assert body["rows"][0]["first_name"] == "Chris"


def test_common_header_aliases_are_auto_detected(client, coach_headers):
    aliased = "player first,player last,#,pos\nChris,Smith,2,WR\n"
    response = preview(client, coach_headers, aliased)
    body = response.get_json()
    assert body["detected_mapping"]["first_name"] == "player first"
    assert body["detected_mapping"]["jersey_number"] == "#"
    assert body["rows"][0]["first_name"] == "Chris"
    assert body["rows"][0]["jersey_number"] == "2"


def test_manual_column_mapping_overrides_detection(client, coach_headers):
    ambiguous = "Col A,Col B\nChris,Smith\n"
    response = preview(
        client,
        coach_headers,
        ambiguous,
        column_mapping={"first_name": "Col A", "last_name": "Col B"},
    )
    body = response.get_json()
    assert body["rows"][0]["first_name"] == "Chris"
    assert body["rows"][0]["last_name"] == "Smith"


def test_full_name_column_is_parsed_conservatively(client, coach_headers):
    data = "Name,Number\nChris Smith,2\nJordan Van Dyke,15\n"
    response = preview(client, coach_headers, data)
    body = response.get_json()
    first_row, second_row = body["rows"]
    assert first_row["full_name_parsed"] is True
    assert first_row["first_name"] == "Chris"
    assert first_row["last_name"] == "Smith"
    # Multi-word name splits on the LAST space only - documented, predictable
    # behavior, not a guess the coach isn't shown.
    assert second_row["first_name"] == "Jordan Van"
    assert second_row["last_name"] == "Dyke"


def test_invalid_row_blank_name_is_flagged(client, coach_headers):
    # A fully blank line is silently skipped as noise (same convention as
    # the existing roster CSV parser) - this row has data (jersey/position)
    # but no name, which is the real "blank name" validation case.
    data = "First Name,Last Name,Jersey Number,Position\nChris,Smith,2,WR\n,,5,DB\n"
    response = preview(client, coach_headers, data)
    body = response.get_json()
    assert body["valid_count"] == 1
    assert body["invalid_count"] == 1
    assert body["rows"][1]["is_valid"] is False
    assert body["rows"][1]["errors"]


def test_duplicate_names_are_allowed_and_flagged_as_possible_matches(client, coach_headers):
    create = client.post(
        "/api/players", json={"first_name": "Chris", "last_name": "Smith", "jersey_number": "2"},
        headers=coach_headers,
    )
    existing_id = create.get_json()["id"]

    data = "First Name,Last Name,Jersey Number\nChris,Smith,2\n"
    response = preview(client, coach_headers, data)
    body = response.get_json()
    row = body["rows"][0]
    assert row["is_valid"] is True
    assert row["possible_duplicates"][0]["player_id"] == existing_id
    assert row["possible_duplicates"][0]["strong_match"] is True
    # Safest default even with a strong match - never auto-update.
    assert row["default_action"] == "create"


def test_same_name_different_number_is_not_flagged_as_strong_match(client, coach_headers):
    client.post(
        "/api/players", json={"first_name": "Chris", "last_name": "Smith", "jersey_number": "2"},
        headers=coach_headers,
    )
    data = "First Name,Last Name,Jersey Number\nChris,Smith,42\n"
    body = preview(client, coach_headers, data).get_json()
    dup = body["rows"][0]["possible_duplicates"][0]
    assert dup["strong_match"] is False


def test_malformed_empty_input_rejected(client, coach_headers):
    response = preview(client, coach_headers, "")
    assert response.status_code == 422


def test_oversized_file_rejected(client, coach_headers):
    huge = "First Name,Last Name\n" + ("A,B\n" * 100000)  # well over the byte cap
    response = preview(client, coach_headers, huge)
    assert response.status_code == 422


def test_row_limit_enforced(client, coach_headers):
    too_many = "First Name,Last Name\n" + "\n".join(f"P{i},L{i}" for i in range(501))
    response = preview(client, coach_headers, too_many)
    assert response.status_code == 422


def test_spreadsheet_formula_injection_is_neutralized_in_preview(client, coach_headers):
    dangerous = "First Name,Last Name\n=cmd|'/c calc'!A1,Smith\n"
    body = preview(client, coach_headers, dangerous).get_json()
    assert body["rows"][0]["first_name"].startswith("'")


def test_confirmed_import_creates_correct_player_records(client, coach_headers):
    body = preview(client, coach_headers, CSV_SAMPLE).get_json()
    rows = [
        {"first_name": r["first_name"], "last_name": r["last_name"],
         "jersey_number": r["jersey_number"], "position": r["position"], "action": "create"}
        for r in body["rows"]
    ]

    response = confirm(client, coach_headers, rows)
    assert response.status_code == 201
    result = response.get_json()
    assert result["created"] == 2

    all_players = client.get("/api/players", headers=coach_headers).get_json()
    assert {p["full_name"] for p in all_players} == {"Chris Smith", "Jordan Lee"}


def test_import_confirm_transaction_rolls_back_entirely_on_any_invalid_row(client, coach_headers):
    rows = [
        {"first_name": "Valid", "last_name": "Player", "action": "create"},
        {"first_name": "", "last_name": "", "action": "create"},
    ]
    response = confirm(client, coach_headers, rows)
    assert response.status_code == 422
    assert response.get_json()["created"] == 0

    # Nothing from the batch was created - not even the valid row.
    assert client.get("/api/players", headers=coach_headers).get_json() == []


def test_import_update_action_requires_player_in_same_organization(client, coach_headers, register_coach):
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")
    other_player = client.post(
        "/api/players", json={"first_name": "Other", "last_name": "Org"}, headers=other_headers
    ).get_json()

    response = confirm(
        client,
        coach_headers,
        [{"first_name": "Hijack", "last_name": "Attempt", "action": "update",
          "existing_player_id": other_player["id"]}],
    )
    assert response.status_code == 422
    assert client.get(f"/api/players/{other_player['id']}", headers=coach_headers).status_code == 404


def test_import_preview_is_organization_scoped_for_duplicate_detection(client, coach_headers, register_coach):
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")
    client.post(
        "/api/players", json={"first_name": "Chris", "last_name": "Smith"}, headers=other_headers
    )

    body = preview(client, coach_headers, "First Name,Last Name\nChris,Smith\n").get_json()
    assert body["rows"][0]["possible_duplicates"] == []


def test_import_template_download(client, coach_headers):
    response = client.get("/api/players/import/template.csv", headers=coach_headers)
    assert response.status_code == 200
    assert "First Name,Last Name,Jersey Number,Position" in response.get_data(as_text=True)
