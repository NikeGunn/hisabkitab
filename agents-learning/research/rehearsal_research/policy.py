"""Linear softmax policy over skills.

    logits = W @ x            W: (n_skills, n_features), x: binary feature vector
    pi(a|x) = softmax(logits)

The score function has a closed form, which is all policy-gradient methods need:

    d/dW log pi(a|x) = (onehot(a) - pi(.|x)) outer x
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np


class LinearSoftmaxPolicy:
    def __init__(self, skills: list[str], features: list[str], rng: np.random.Generator, init_scale: float = 0.0) -> None:
        self.skills = list(skills)
        self.features = list(features)
        self.W = init_scale * rng.standard_normal((len(skills), len(features)))

    def probs(self, x: np.ndarray) -> np.ndarray:
        z = self.W @ x
        z = z - z.max()  # numerical stability: softmax is shift-invariant
        e = np.exp(z)
        return e / e.sum()

    def sample(self, x: np.ndarray, rng: np.random.Generator) -> int:
        return int(rng.choice(len(self.skills), p=self.probs(x)))

    def greedy(self, x: np.ndarray) -> int:
        return int(np.argmax(self.W @ x))

    def grad_log_prob(self, x: np.ndarray, a: int) -> np.ndarray:
        g = -self.probs(x)
        g[a] += 1.0
        return np.outer(g, x)

    def entropy_grad(self, x: np.ndarray) -> np.ndarray:
        """Gradient of H(pi(.|x)) = -sum p log p w.r.t. W (keeps exploration alive)."""
        p = self.probs(x)
        logp = np.log(p + 1e-12)
        h = -(p * logp).sum()
        # dH/dz_k = -p_k (log p_k + H)
        dz = -p * (logp + h)
        return np.outer(dz, x)

    def save(self, path: Path, name: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Same layout the TypeScript PolicyAgent loads (it refuses a mismatched skill/feature order).
        path.write_text(json.dumps({"name": name, "skills": self.skills, "features": self.features, "W": self.W.round(6).tolist()}, indent=1))
