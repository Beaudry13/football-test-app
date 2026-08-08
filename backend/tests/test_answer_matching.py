"""How a typed answer is matched. The whole of FILL_BLANK's correctness."""

import pytest

from app.services.answer_matching import (
    CASE_INSENSITIVE,
    EXACT,
    NORMALISED,
    clean_expected_answers,
    matches,
    normalise,
)


class TestNormalisedMode:
    @pytest.mark.parametrize(
        "given",
        ["Cover 3", "cover 3", "COVER 3", "  Cover 3  ", "Cover  3", "\tCover\n3 "],
    )
    def test_forgives_only_meaningless_differences(self, given):
        assert matches(given, ["Cover 3"]) is True

    def test_folds_typographic_punctuation(self):
        # A coach pastes from a PDF and gets a curly apostrophe or an en dash;
        # a player on a phone keyboard types the plain one. They look identical
        # on screen, so treating them as different answers is indefensible.
        assert matches("Sam's call", ["Sam’s call"]) is True
        assert matches("2-high", ["2–high"]) is True

    def test_does_not_forgive_a_different_call(self):
        # THE point of not doing fuzzy matching: one character apart, opposite
        # meanings. A quiz that marks this correct is worse than no quiz.
        assert matches("Cover 2", ["Cover 3"]) is False
        assert matches("Over", ["Under"]) is False
        assert matches("Cover 33", ["Cover 3"]) is False

    def test_does_not_forgive_a_typo(self):
        assert matches("Covr 3", ["Cover 3"]) is False


class TestMultipleAcceptedAnswers:
    def test_any_listed_variant_is_accepted(self):
        accepted = ["Cover 3", "C3", "Cvr 3"]
        for given in accepted:
            assert matches(given, accepted) is True

    def test_an_unlisted_variant_is_not_guessed(self):
        # Variation is handled by the coach listing it, never by the system
        # inferring it.
        assert matches("Cov3", ["Cover 3", "C3"]) is False


class TestBlankAndMissing:
    @pytest.mark.parametrize("given", [None, "", "   ", "\n\t"])
    def test_blank_never_matches(self, given):
        assert matches(given, ["Cover 3"]) is False

    def test_blank_does_not_match_a_blank_expectation(self):
        # A question answerable by typing nothing is not a question.
        assert matches("", [""]) is False
        assert matches("   ", ["   "]) is False

    @pytest.mark.parametrize("expected", [None, []])
    def test_no_expected_answers_never_matches(self, expected):
        assert matches("anything", expected) is False


class TestOtherModes:
    def test_exact_is_character_for_character(self):
        assert matches("Cover 3", ["Cover 3"], EXACT) is True
        assert matches("cover 3", ["Cover 3"], EXACT) is False
        assert matches(" Cover 3", ["Cover 3"], EXACT) is False

    def test_case_insensitive_keeps_whitespace_significant(self):
        assert matches("cover 3", ["Cover 3"], CASE_INSENSITIVE) is True
        assert matches("cover  3", ["Cover 3"], CASE_INSENSITIVE) is False

    def test_an_unknown_mode_falls_back_to_normalised_not_exact(self):
        # A bad stored value must not silently become the strictest mode, which
        # would fail answers that should pass and be near-impossible for a
        # coach to diagnose.
        assert matches("  cover 3 ", ["Cover 3"], "nonsense-mode") is True

    def test_none_mode_is_the_default(self):
        assert matches("  cover 3 ", ["Cover 3"], None) is True


class TestNormaliseDirectly:
    def test_collapses_and_folds(self):
        assert normalise("  Cover   3  ", NORMALISED) == "cover 3"

    def test_none_is_empty(self):
        assert normalise(None) == ""


class TestCleanExpectedAnswers:
    def test_trims_and_drops_blanks(self):
        assert clean_expected_answers(["  Cover 3 ", "", "   ", "C3"]) == ["Cover 3", "C3"]

    def test_removes_duplicates_that_differ_only_cosmetically(self):
        assert clean_expected_answers(["Cover 3", "cover 3", "  COVER 3"]) == ["Cover 3"]

    def test_preserves_the_coachs_casing(self):
        # Shown back in the editor and in the PDF export. Lower-casing a
        # coach's play names there would look broken.
        assert clean_expected_answers(["Cover 3", "TEX"]) == ["Cover 3", "TEX"]

    def test_preserves_order(self):
        assert clean_expected_answers(["C3", "Cover 3", "Cvr 3"]) == ["C3", "Cover 3", "Cvr 3"]

    @pytest.mark.parametrize("raw", [None, [], ["", "  "]])
    def test_nothing_usable_is_an_empty_list(self, raw):
        assert clean_expected_answers(raw) == []
