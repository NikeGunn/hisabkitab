"""GRPO-style policy gradient (Group Relative Policy Optimization, Shao et al. 2024 — DeepSeekMath).

For each scenario, sample a GROUP of G episodes from the current policy. The
advantage of episode i is its reward relative to its own group:

    A_i = (r_i - mean(r_group)) / (std(r_group) + eps)

so no value network (critic) is needed: the group is its own baseline. The update
is the REINFORCE estimator weighted by A_i, summed over every decision in the
episode, plus a small entropy bonus to keep exploring.

This is the faithful, minimal core of GRPO. Not included (documented as
limitations): the PPO-style ratio clipping and KL-to-reference term, which matter
when the policy is a large LM updated off-policy for several epochs; here each
batch is used once, on-policy, so the ratio is exactly 1.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .client import LabClient
from .policy import LinearSoftmaxPolicy
from .rewards import Reward


@dataclass
class Episode:
    scenario_id: str
    decisions: list[tuple[np.ndarray, int]] = field(default_factory=list)
    verdict: dict = field(default_factory=dict)


def rollout(client: LabClient, policy: LinearSoftmaxPolicy, scenario_id: str, rng: np.random.Generator | None, max_decisions: int = 8) -> Episode:
    """Play one episode. rng=None means greedy (evaluation)."""
    ep = Episode(scenario_id)
    session, point = client.reset(scenario_id)
    while not point.done and len(ep.decisions) < max_decisions:
        x = np.asarray(point.features, dtype=float)
        a = policy.greedy(x) if rng is None else policy.sample(x, rng)
        ep.decisions.append((x, a))
        point = client.step(session, a)
    if point.verdict is None:  # every episode ends: the owner script and the env step cap are finite
        raise RuntimeError(f"{scenario_id}: no verdict after {max_decisions} decisions")
    ep.verdict = point.verdict
    return ep


@dataclass
class TrainConfig:
    iterations: int = 40
    batch: int = 12  # scenarios per iteration
    group: int = 8  # episodes per scenario (the "G" in GRPO)
    lr: float = 0.5
    entropy: float = 0.01
    seed: int = 0


def train(client: LabClient, policy: LinearSoftmaxPolicy, scenario_ids: list[str], reward: Reward, cfg: TrainConfig, on_iteration=None) -> list[dict]:
    rng = np.random.default_rng(cfg.seed)
    curve: list[dict] = []
    for it in range(cfg.iterations):
        batch = rng.choice(scenario_ids, size=min(cfg.batch, len(scenario_ids)), replace=False)
        grad = np.zeros_like(policy.W)
        rewards, judge, passed, hard = [], [], [], []
        n_decisions = 0
        for sid in batch:
            group = [rollout(client, policy, str(sid), rng) for _ in range(cfg.group)]
            r = np.array([reward(e.verdict) for e in group])
            adv = (r - r.mean()) / (r.std() + 1e-8) if r.std() > 1e-12 else np.zeros_like(r)
            for e, a_i in zip(group, adv):
                for x, a in e.decisions:
                    grad += a_i * policy.grad_log_prob(x, a) + cfg.entropy * policy.entropy_grad(x)
                    n_decisions += 1
                v = e.verdict
                rewards.append(reward(v))
                judge.append(v["reward"])
                passed.append(1.0 if v["passed"] else 0.0)
                hard.append(1.0 if v["hard"] else 0.0)
        policy.W += cfg.lr * grad / max(n_decisions, 1)
        point = {
            "iteration": it,
            "mean_training_reward": round(float(np.mean(rewards)), 4),
            "mean_judge_reward": round(float(np.mean(judge)), 4),
            "pass_rate": round(float(np.mean(passed)), 4),
            "hard_violation_rate": round(float(np.mean(hard)), 4),
        }
        curve.append(point)
        if on_iteration:
            on_iteration(point)
    return curve


def evaluate_greedy(client: LabClient, policy: LinearSoftmaxPolicy, scenario_ids: list[str]) -> list[dict]:
    out = []
    for sid in scenario_ids:
        v = rollout(client, policy, sid, rng=None).verdict
        out.append({"scenario_id": sid, "passed": bool(v["passed"]), "reward": v["reward"], "failure_class": v["failure_class"], "hard": [h["code"] for h in v["hard"]]})
    return out
