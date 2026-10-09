import numpy as np
import pytest

from rehearsal_research.stats import bootstrap_ci, paired_bootstrap_diff


def test_bootstrap_ci_contains_mean_and_is_reproducible():
    v = [1, 0, 1, 1, 0, 1, 1, 1, 0, 1]
    m, lo, hi = bootstrap_ci(v, seed=7)
    assert lo <= m <= hi and m == pytest.approx(0.7)
    assert bootstrap_ci(v, seed=7) == (m, lo, hi)  # same seed, same interval


def test_all_pass_has_degenerate_interval():
    assert bootstrap_ci([1] * 20)[1:] == (1.0, 1.0)


def test_paired_diff_detects_consistent_improvement():
    a = np.zeros(30)
    b = np.ones(30)
    m, lo, hi = paired_bootstrap_diff(a, b)
    assert m == 1 and lo > 0


def test_paired_needs_alignment():
    with pytest.raises(ValueError):
        paired_bootstrap_diff([1, 0], [1])
