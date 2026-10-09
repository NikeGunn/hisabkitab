"""GRPO on a fake environment where the right skill is known: it must learn it."""
import numpy as np

from rehearsal_research.client import DecisionPoint
from rehearsal_research.grpo import TrainConfig, evaluate_greedy, train
from rehearsal_research.policy import LinearSoftmaxPolicy
from rehearsal_research.rewards import v0_naive, v1_judge


class Bandit:
    """One decision. Feature 1 on → skill 2 is right; off → skill 0. Skill 1 'saves without asking'."""

    def __init__(self):
        self.sessions = {}

    def reset(self, sid):
        x = [1, 1 if sid.endswith("odd") else 0] + [0] * 10
        self.sessions[sid] = x
        return sid, DecisionPoint(False, x, None)

    def step(self, sid, a):
        right = 2 if self.sessions[sid][1] else 0
        hard = [{"code": "UNAPPROVED_SAVE"}] if a == 1 else []
        reward = -1.0 if hard else (1.0 if a == right else 0.2)
        verdict = {"passed": a == right, "reward": reward, "hard": hard, "failure_class": "PASS" if a == right else "X",
                   "outcome": {"score": 1.0 if a in (right, 1) else 0.0}, "steps": 1 if a == 1 else 3}
        return DecisionPoint(True, None, verdict)


def test_grpo_learns_the_right_skill_under_the_judge_reward():
    env = Bandit()
    pol = LinearSoftmaxPolicy(list("abcdef"), [f"f{i}" for i in range(12)], np.random.default_rng(0))
    train(env, pol, ["s-even", "s-odd"], v1_judge, TrainConfig(iterations=60, batch=2, group=8, lr=1.0, seed=0))
    results = evaluate_greedy(env, pol, ["s-even", "s-odd"])
    assert all(r["passed"] for r in results)


def test_naive_reward_is_hackable():
    """v0 pays for a correct outcome in few steps and ignores safety → policy learns the unsafe shortcut."""
    env = Bandit()
    pol = LinearSoftmaxPolicy(list("abcdef"), [f"f{i}" for i in range(12)], np.random.default_rng(0))
    train(env, pol, ["s-even", "s-odd"], v0_naive, TrainConfig(iterations=60, batch=2, group=8, lr=1.0, seed=0))
    results = evaluate_greedy(env, pol, ["s-even", "s-odd"])
    assert all(r["hard"] == ["UNAPPROVED_SAVE"] for r in results)
