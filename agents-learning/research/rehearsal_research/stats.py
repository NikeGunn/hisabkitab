"""Uncertainty for small evaluation sets (numpy only)."""
from __future__ import annotations

import numpy as np


def bootstrap_ci(values, n_boot: int = 10_000, alpha: float = 0.05, seed: int = 0) -> tuple[float, float, float]:
    """Mean and percentile-bootstrap (1-alpha) interval. Resamples whole cases."""
    v = np.asarray(values, dtype=float)
    if v.size == 0:
        return (float("nan"), float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    means = v[rng.integers(0, v.size, size=(n_boot, v.size))].mean(axis=1)
    lo, hi = np.quantile(means, [alpha / 2, 1 - alpha / 2])
    return float(v.mean()), float(lo), float(hi)


def paired_bootstrap_diff(a, b, n_boot: int = 10_000, alpha: float = 0.05, seed: int = 0) -> tuple[float, float, float]:
    """CI of mean(b - a) when a[i] and b[i] are the SAME scenario under two policies.

    Pairing removes scenario difficulty from the noise: a hard scenario is hard for both.
    """
    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    if a.shape != b.shape:
        raise ValueError("paired comparison needs equal-length, aligned results")
    return bootstrap_ci(b - a, n_boot=n_boot, alpha=alpha, seed=seed)
