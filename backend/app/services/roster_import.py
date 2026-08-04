"""Master-roster CSV/pasted-spreadsheet import: parse -> preview -> confirm.

Two-step, not a single upload-and-create: `build_preview` never writes to
the database - it only parses, validates, and suggests duplicate matches,
so a coach can review and correct everything before anything is created.
`apply_import` is the only function that writes, and does so in exactly
one transaction (see its docstring for the all-or-nothing policy).
"""

import csv
import io
import re

from app.models import Player

MAX_IMPORT_TEXT_BYTES = 200_000
MAX_IMPORT_ROWS = 500

# Values from any spreadsheet cell that begin with one of these characters
# can be interpreted as a formula by Excel/Sheets when the cell is later
# opened - a classic CSV/spreadsheet-injection vector. Neutralized (not
# rejected) by prefixing a single quote, both when a value is echoed back
# in a preview response and whenever we generate a CSV ourselves (the
# template, an error-report download) - matches OWASP's standard mitigation.
_FORMULA_TRIGGER_CHARS = ("=", "+", "-", "@", "\t", "\r")


def sanitize_for_spreadsheet(value: str) -> str:
    if value and value[0] in _FORMULA_TRIGGER_CHARS:
        return "'" + value
    return value


FIRST_NAME_ALIASES = {"first", "first name", "firstname", "player first"}
LAST_NAME_ALIASES = {"last", "last name", "lastname", "player last"}
FULL_NAME_ALIASES = {"name", "player", "player name", "athlete"}
JERSEY_ALIASES = {"number", "no", "no.", "jersey", "jersey number", "#"}
POSITION_ALIASES = {"position", "pos"}


def _detect_column_mapping(header: list[str]) -> dict[str, int | None]:
    lowered = [h.strip().lower() for h in header]
    mapping: dict[str, int | None] = {
        "first_name": None,
        "last_name": None,
        "full_name": None,
        "jersey_number": None,
        "position": None,
    }
    for i, cell in enumerate(lowered):
        if mapping["first_name"] is None and cell in FIRST_NAME_ALIASES:
            mapping["first_name"] = i
        elif mapping["last_name"] is None and cell in LAST_NAME_ALIASES:
            mapping["last_name"] = i
        elif mapping["full_name"] is None and cell in FULL_NAME_ALIASES:
            mapping["full_name"] = i
        elif mapping["jersey_number"] is None and cell in JERSEY_ALIASES:
            mapping["jersey_number"] = i
        elif mapping["position"] is None and cell in POSITION_ALIASES:
            mapping["position"] = i
    return mapping


def _split_full_name(full_name: str) -> tuple[str, str]:
    """Conservative "First Last" split: everything but the last
    whitespace-separated token is the first name, the last token is the
    last name. Deliberately simple rather than clever - a name with a
    suffix ("Jordan Smith Jr.") or a multi-word last name ("Jordan Van Dyke")
    will split imperfectly, but predictably so, and the caller always shows
    the parsed result in the preview for the coach to correct rather than
    silently trusting it.
    """
    parts = full_name.strip().split()
    if len(parts) == 1:
        return parts[0], ""
    return " ".join(parts[:-1]), parts[-1]


def _parse_rows(raw_text: str) -> tuple[list[str], list[list[str]]]:
    # Pasted spreadsheet data (copied from Excel/Sheets) is tab-separated;
    # an uploaded .csv file is comma-separated. Detect by whichever
    # delimiter appears more often in the header line - simpler and more
    # robust here than csv.Sniffer, which gets confused by short/uniform
    # header rows.
    first_line = raw_text.splitlines()[0] if raw_text.splitlines() else ""
    delimiter = "\t" if first_line.count("\t") > first_line.count(",") else ","

    reader = csv.reader(io.StringIO(raw_text), delimiter=delimiter)
    rows = [row for row in reader if any(cell.strip() for cell in row)]
    if not rows:
        return [], []
    return rows[0], rows[1:]


def build_preview(
    raw_text: str, organization_id: int, column_mapping: dict[str, str | None] | None = None
) -> dict:
    """`column_mapping`, when provided, is a manual override keyed by field
    name with the *source header text* as the value (e.g.
    {"first_name": "Player First", "jersey_number": "#"}) - the same
    strings shown to the coach in `available_columns` - not a column
    index, since the frontend picker works off header names, not
    positions. `None`/omitted re-runs automatic alias-based detection.
    """
    if len(raw_text.encode("utf-8")) > MAX_IMPORT_TEXT_BYTES:
        return {"error": "File is too large. Please import 500 players or fewer at a time."}, []

    header, data_rows = _parse_rows(raw_text)
    if not header:
        return {"error": "No data found. Paste a header row and at least one player."}, []
    if len(data_rows) > MAX_IMPORT_ROWS:
        return {
            "error": f"Too many rows ({len(data_rows)}). Please import {MAX_IMPORT_ROWS} or fewer at a time."
        }, []

    if column_mapping is not None:
        mapping = {
            field: (header.index(source_header) if source_header else None)
            for field, source_header in column_mapping.items()
            if source_header is None or source_header in header
        }
        for field in ("first_name", "last_name", "full_name", "jersey_number", "position"):
            mapping.setdefault(field, None)
    else:
        mapping = _detect_column_mapping(header)

    # Existing roster, loaded once - normalized-name -> list of candidate
    # matches, so every row's duplicate check is an in-memory lookup
    # instead of a query per row.
    existing_players = Player.query.filter_by(organization_id=organization_id).all()
    existing_by_name: dict[str, list[Player]] = {}
    for p in existing_players:
        key = f"{p.first_name.strip().lower()} {p.last_name.strip().lower()}"
        existing_by_name.setdefault(key, []).append(p)

    def cell(row: list[str], index: int | None) -> str:
        if index is None or index >= len(row):
            return ""
        return row[index].strip()

    preview_rows = []
    valid_count = 0
    for row_number, row in enumerate(data_rows, start=2):  # header is row 1
        full_name_parsed = False
        first_name = cell(row, mapping.get("first_name"))
        last_name = cell(row, mapping.get("last_name"))
        if not first_name and not last_name and mapping.get("full_name") is not None:
            full_name = cell(row, mapping["full_name"])
            if full_name:
                first_name, last_name = _split_full_name(full_name)
                full_name_parsed = True

        jersey_number = cell(row, mapping.get("jersey_number")) or None
        position = cell(row, mapping.get("position")) or None

        errors = []
        if not first_name and not last_name:
            errors.append("First and last name cannot both be blank")

        possible_duplicates = []
        if first_name or last_name:
            key = f"{first_name.lower()} {last_name.lower()}"
            for candidate in existing_by_name.get(key, []):
                possible_duplicates.append(
                    {
                        "player_id": candidate.id,
                        "first_name": candidate.first_name,
                        "last_name": candidate.last_name,
                        "jersey_number": candidate.jersey_number,
                        "position": candidate.position,
                        # A stronger signal than name alone - number and
                        # position both matching too suggests this really
                        # is the same person re-imported, not just a
                        # same-name teammate.
                        "strong_match": (
                            candidate.jersey_number == jersey_number
                            and candidate.position == position
                        ),
                    }
                )

        is_valid = len(errors) == 0
        if is_valid:
            valid_count += 1

        preview_rows.append(
            {
                "row_number": row_number,
                "first_name": sanitize_for_spreadsheet(first_name),
                "last_name": sanitize_for_spreadsheet(last_name),
                "jersey_number": sanitize_for_spreadsheet(jersey_number) if jersey_number else None,
                "position": sanitize_for_spreadsheet(position) if position else None,
                "full_name_parsed": full_name_parsed,
                "is_valid": is_valid,
                "errors": errors,
                "possible_duplicates": possible_duplicates,
                # Safest non-destructive default: never auto-update or
                # auto-skip based on a guessed match - a coach must
                # explicitly choose that at confirm time.
                "default_action": "create" if is_valid else "skip",
            }
        )

    return {
        "detected_mapping": {
            k: (header[v] if v is not None else None) for k, v in mapping.items()
        },
        "available_columns": header,
        "total_rows": len(data_rows),
        "valid_count": valid_count,
        "invalid_count": len(data_rows) - valid_count,
    }, preview_rows


def apply_import(rows: list[dict], organization_id: int) -> dict:
    """Creates/updates Players for a confirmed import.

    All-or-nothing: every row is validated before anything is written, and
    the whole batch commits in one transaction. A single bad row (blank
    name, or an existing_player_id that isn't in this organization) fails
    the entire import rather than silently creating a partial result -
    deliberately, so "how many of my 75 players actually got imported"
    never has an ambiguous answer. The caller gets back exactly which rows
    failed and why, before anything is committed, so they can fix and
    resubmit with confidence nothing was half-applied.
    """
    errors_by_row = []
    to_create: list[Player] = []
    to_update: list[tuple[Player, dict]] = []

    existing_ids = {
        p.id: p
        for p in Player.query.filter(
            Player.organization_id == organization_id,
            Player.id.in_([r["existing_player_id"] for r in rows if r.get("existing_player_id")]),
        ).all()
    }

    for index, row in enumerate(rows):
        action = row.get("action", "create")
        if action == "skip":
            continue

        first_name = (row.get("first_name") or "").strip()
        last_name = (row.get("last_name") or "").strip()
        if action in ("create", "update") and not first_name and not last_name:
            errors_by_row.append({"index": index, "error": "First and last name cannot both be blank"})
            continue

        jersey_number = (row.get("jersey_number") or "").strip() or None
        position = (row.get("position") or "").strip() or None

        if action == "create":
            to_create.append(
                Player(
                    organization_id=organization_id,
                    first_name=first_name,
                    last_name=last_name,
                    jersey_number=jersey_number,
                    position=position,
                )
            )
        elif action == "update":
            existing_player_id = row.get("existing_player_id")
            player = existing_ids.get(existing_player_id)
            if player is None:
                errors_by_row.append(
                    {"index": index, "error": "Selected player to update was not found"}
                )
                continue
            to_update.append(
                (player, {"first_name": first_name, "last_name": last_name,
                          "jersey_number": jersey_number, "position": position})
            )
        else:
            errors_by_row.append({"index": index, "error": f"Unknown action '{action}'"})

    if errors_by_row:
        return {"success": False, "errors": errors_by_row, "created": 0, "updated": 0}

    from app.extensions import db

    for player in to_create:
        db.session.add(player)
    for player, fields in to_update:
        player.first_name = fields["first_name"]
        player.last_name = fields["last_name"]
        player.jersey_number = fields["jersey_number"]
        player.position = fields["position"]

    db.session.commit()
    return {
        "success": True,
        "errors": [],
        "created": len(to_create),
        "updated": len(to_update),
        "players": [p.to_dict() for p in to_create],
    }
