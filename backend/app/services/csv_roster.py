"""Parses a coach-uploaded roster CSV into a flat list of player names.

Accepts either a single unlabeled column of names, or a column headed
`name` / `player_name` (case-insensitive) among other columns.
"""

import csv
import io

from app.errors import ApiError

NAME_HEADER_CANDIDATES = {"name", "player_name", "player"}


def parse_roster_csv(raw_bytes: bytes) -> list[str]:
    try:
        text = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ApiError("CSV file must be UTF-8 encoded", status_code=400) from exc

    reader = csv.reader(io.StringIO(text))
    rows = [row for row in reader if any(cell.strip() for cell in row)]
    if not rows:
        raise ApiError("CSV file is empty", status_code=400)

    header = [cell.strip().lower() for cell in rows[0]]
    name_column = next((i for i, cell in enumerate(header) if cell in NAME_HEADER_CANDIDATES), None)

    if name_column is not None:
        data_rows = rows[1:]
    else:
        # No recognized header - treat every row's first column as a name.
        name_column = 0
        data_rows = rows

    names = [row[name_column].strip() for row in data_rows if len(row) > name_column]
    names = [name for name in names if name]

    if not names:
        raise ApiError("No player names found in CSV file", status_code=400)

    return names
