"""Matching a typed answer against what the coach accepts.

THE ONE PLACE FILL_BLANK IS GRADED. `attempts.upsert_answer` calls it; nothing
else decides whether typed text is right. Keeping it here rather than inline in
the route is what stops FILL_BLANK becoming a scattered special case - the same
discipline CLAUDE.md records for the CORRECT/INCORRECT vocabulary.

WHY NOT FUZZY MATCHING
The tempting feature is Levenshtein distance, so "Cover3" matches "Cover 3".
It is a trap for this domain specifically: "Cover 2" and "Cover 3" are one
character apart and mean opposite things, as do "Under" and "Over" front calls
at two. Any threshold loose enough to forgive a typo is loose enough to mark a
genuinely wrong coverage correct - and a quiz that marks wrong answers right is
worse than useless to a coach, because they will trust it.

Multiple accepted answers cover real variation instead. A coach who wants
"Cover 3", "C3" and "Cvr 3" all accepted lists all three, and the system never
guesses on their behalf.
"""

from __future__ import annotations

import re
import unicodedata

#: Character-for-character, including case and every space.
EXACT = "exact"
#: Case-folded, but whitespace still significant.
CASE_INSENSITIVE = "case_insensitive"
#: Trimmed, internal whitespace collapsed, case-folded, punctuation-normalised.
#: The default, because it forgives only differences a coach would never
#: consider meaningful.
NORMALISED = "normalised"

DEFAULT_MODE = NORMALISED
VALID_MODES = frozenset({EXACT, CASE_INSENSITIVE, NORMALISED})

#: A coach copying from a PDF picks up typographic dashes and curly quotes that
#: a player on a phone keyboard cannot reproduce. Folding them is not fuzzy
#: matching - the characters are visually identical to the reader and differ
#: only in how the exporter encoded them.
_PUNCTUATION_FOLD = {
    "‘": "'",  # left single quote
    "’": "'",  # right single quote / apostrophe
    "“": '"',
    "”": '"',
    "–": "-",  # en dash
    "—": "-",  # em dash
    "−": "-",  # minus sign
    " ": " ",  # non-breaking space
}

_WHITESPACE = re.compile(r"\s+")


def normalise(text: str, mode: str = DEFAULT_MODE) -> str:
    """The canonical form `mode` compares against."""
    if text is None:
        return ""

    if mode == EXACT:
        return text

    if mode == CASE_INSENSITIVE:
        return text.casefold()

    # NORMALISED, and the fallback for an unrecognised mode - an unknown value
    # must not silently become EXACT, which would fail answers that should
    # pass and be very hard to diagnose from a coach's side.
    folded = "".join(_PUNCTUATION_FOLD.get(char, char) for char in text)
    # NFKC so a full-width or composed character compares equal to the plain
    # form a different keyboard produces.
    folded = unicodedata.normalize("NFKC", folded)
    return _WHITESPACE.sub(" ", folded).strip().casefold()


def matches(given: str | None, expected: list[str] | None, mode: str | None = None) -> bool:
    """Whether `given` is one of the accepted answers.

    Blank input is never a match, including against a blank expected answer -
    a question that could be answered by typing nothing is not a question.
    """
    if not expected:
        return False

    mode = mode or DEFAULT_MODE
    candidate = normalise(given or "", mode)
    if not candidate.strip():
        return False

    return any(candidate == normalise(str(option), mode) for option in expected)


def clean_expected_answers(raw: list[str] | None) -> list[str]:
    """The stored form of a coach's list: trimmed, blanks dropped, duplicates
    removed, original order and original casing kept.

    Casing is preserved deliberately even though NORMALISED ignores it - the
    list is shown back to the coach in the editor and in exports, and
    lower-casing their play names there would look broken.
    """
    if not raw:
        return []

    cleaned: list[str] = []
    seen: set[str] = set()
    for entry in raw:
        text = str(entry).strip()
        if not text:
            continue
        key = normalise(text, NORMALISED)
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(text)
    return cleaned
