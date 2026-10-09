import numpy as np

from rehearsal_research.policy import LinearSoftmaxPolicy


def make(seed=0):
    rng = np.random.default_rng(seed)
    return LinearSoftmaxPolicy(list("abcdef"), [f"f{i}" for i in range(12)], rng, init_scale=0.5), rng


def test_probs_are_a_distribution():
    p, rng = make()
    x = rng.integers(0, 2, 12).astype(float)
    pr = p.probs(x)
    assert np.all(pr > 0) and abs(pr.sum() - 1) < 1e-12


def test_score_function_matches_finite_differences():
    """d/dW log pi(a|x): analytic formula vs central differences — the classic gradient check."""
    p, rng = make(1)
    x = rng.integers(0, 2, 12).astype(float)
    a = 3
    analytic = p.grad_log_prob(x, a)
    numeric = np.zeros_like(p.W)
    eps = 1e-6
    for i in range(p.W.shape[0]):
        for j in range(p.W.shape[1]):
            p.W[i, j] += eps
            up = np.log(p.probs(x)[a])
            p.W[i, j] -= 2 * eps
            down = np.log(p.probs(x)[a])
            p.W[i, j] += eps
            numeric[i, j] = (up - down) / (2 * eps)
    assert np.max(np.abs(analytic - numeric)) < 1e-6


def test_entropy_gradient_matches_finite_differences():
    p, rng = make(2)
    x = rng.integers(0, 2, 12).astype(float)

    def H():
        q = p.probs(x)
        return -(q * np.log(q)).sum()

    analytic = p.entropy_grad(x)
    numeric = np.zeros_like(p.W)
    eps = 1e-6
    for i in range(p.W.shape[0]):
        for j in range(p.W.shape[1]):
            p.W[i, j] += eps
            up = H()
            p.W[i, j] -= 2 * eps
            down = H()
            p.W[i, j] += eps
            numeric[i, j] = (up - down) / (2 * eps)
    assert np.max(np.abs(analytic - numeric)) < 1e-6


def test_softmax_is_stable_for_huge_logits():
    p, _ = make()
    p.W[:] = 1e4
    p.W[2] = 2e4
    pr = p.probs(np.ones(12))
    assert np.isfinite(pr).all() and pr.argmax() == 2
