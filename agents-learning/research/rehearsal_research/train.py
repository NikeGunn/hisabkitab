"""Train a skill policy with GRPO and record everything needed to reproduce it.

    python -m rehearsal_research.train --reward v1_judge --seed 0
    python -m rehearsal_research.train --reward v0_naive --seed 0     # the reward-hacking ablation

Trains on the TRAIN split, picks nothing on test (the server will not even serve it),
reports greedy results on DEV. Final held-out TEST numbers come from the TypeScript
side, which loads the saved weights:  pnpm lab eval --agent policy:<weights> --split test
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np

from .client import LabClient
from .grpo import TrainConfig, evaluate_greedy, train
from .policy import LinearSoftmaxPolicy
from .rewards import REWARDS
from .stats import bootstrap_ci

ROOT = Path(__file__).resolve().parents[1]


def traced(fn):
    """Wrap with LangSmith @traceable when tracing is on (one trace per training run)."""
    if os.environ.get("LANGSMITH_TRACING") == "true" and os.environ.get("LANGSMITH_API_KEY"):
        from langsmith import traceable

        return traceable(name="rehearsal.grpo_training", run_type="chain", tags=["training", "grpo"])(fn)
    return fn


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reward", choices=sorted(REWARDS), default="v1_judge")
    ap.add_argument("--iterations", type=int, default=40)
    ap.add_argument("--batch", type=int, default=12)
    ap.add_argument("--group", type=int, default=8)
    ap.add_argument("--lr", type=float, default=0.5)
    ap.add_argument("--entropy", type=float, default=0.01)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--url", default=os.environ.get("LAB_URL", "http://127.0.0.1:8820"))
    ap.add_argument("--report", action="store_true", help="POST the run to the lab DB (needs LAB_API_TOKEN)")
    args = ap.parse_args()

    client = LabClient(args.url, token=os.environ.get("LAB_API_TOKEN"))
    spec = client.spec()
    train_ids, dev_ids = client.scenarios("train"), client.scenarios("dev")
    cfg = TrainConfig(args.iterations, args.batch, args.group, args.lr, args.entropy, args.seed)
    name = f"grpo-{args.reward}-seed{args.seed}"
    policy = LinearSoftmaxPolicy(spec["skills"], spec["features"], np.random.default_rng(args.seed))

    @traced
    def run(config: dict) -> dict:  # `config` is recorded as the trace inputs
        t0 = time.time()
        before = evaluate_greedy(client, policy, dev_ids)
        curve = train(client, policy, train_ids, REWARDS[args.reward], cfg,
                      on_iteration=lambda p: print(json.dumps(p)) if p["iteration"] % 5 == 0 else None)
        after = evaluate_greedy(client, policy, dev_ids)
        return {"curve": curve, "dev_before": before, "dev_after": after, "seconds": round(time.time() - t0, 1)}

    out = run({"name": name, **asdict(cfg), "reward": args.reward})
    weights = ROOT / "weights" / f"{name}.json"
    policy.save(weights, name)

    def summary(rows):
        m, lo, hi = bootstrap_ci([r["passed"] for r in rows], seed=args.seed)
        return {"pass_rate": round(m, 4), "ci95": [round(lo, 4), round(hi, 4)], "hard": sum(len(r["hard"]) for r in rows), "n": len(rows)}

    result = {
        "name": name,
        "algorithm": "grpo(no-clip, no-kl, on-policy)",
        "reward_version": args.reward,
        "config": {**asdict(cfg), "dataset_version": spec["dataset_version"], "env_version": spec.get("env_version"), "judge_version": spec.get("judge_version"), "numpy": np.__version__, "python": platform.python_version()},
        "curve": out["curve"],
        "evaluation": {"dev_before": summary(out["dev_before"]), "dev_after": summary(out["dev_after"]), "dev_cases_after": out["dev_after"],
                       "weights_file": str(weights.relative_to(ROOT.parent)), "seconds": out["seconds"]},
    }
    results = ROOT / "results" / f"{name}.json"
    results.parent.mkdir(parents=True, exist_ok=True)
    results.write_text(json.dumps(result, indent=1))
    print(json.dumps({"dev_before": result["evaluation"]["dev_before"], "dev_after": result["evaluation"]["dev_after"]}))
    print(f"weights -> {weights}\nresults -> {results}\nheld-out test: pnpm lab eval --agent policy:research/weights/{name}.json --split test")
    if args.report:
        print("recorded in lab DB as training run", client.report_training_run({k: result[k] for k in ("name", "algorithm", "reward_version", "config", "curve", "evaluation")}))


if __name__ == "__main__":
    main()
