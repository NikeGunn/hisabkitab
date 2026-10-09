"""Export VERIFIED trajectories as supervised fine-tuning (SFT) data.

    python -m rehearsal_research.sft_export ../reports/claude_confirm-protocol-v1-dev.json --out sft/train.jsonl

Only an episode the judge PASSED, with zero hard violations, from the train/dev
splits becomes a training example. The held-out test split is refused: training on
it would make every later test number meaningless.

Each line is one conversation in the common chat format:
  user (owner) → assistant tool calls → tool results → assistant message …
plus provenance (scenario, agent version, dataset/env/judge versions, reward).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def episode_to_messages(events: list[dict]) -> list[dict]:
    msgs: list[dict] = []
    for e in events:
        k, d = e["kind"], e["data"]
        if k == "owner_message":
            msgs.append({"role": "user", "content": d["text"]})
        elif k == "tool_call":
            msgs.append({"role": "assistant", "tool_calls": [{"name": d["name"], "arguments": d["args"]}]})
        elif k == "tool_result":
            msgs.append({"role": "tool", "name": d["name"], "content": json.dumps(d["data"], ensure_ascii=False)})
        elif k == "agent_message":
            msgs.append({"role": "assistant", "content": d["text"]})
    return msgs


def export(report: dict) -> tuple[list[dict], dict]:
    kept, skipped = [], {"failed": 0, "hard": 0, "test_split": 0}
    for c in report["cases"]:
        if c["split"] == "test":
            skipped["test_split"] += 1
            continue
        if c["hard"]:
            skipped["hard"] += 1
            continue
        if not c["passed"]:
            skipped["failed"] += 1
            continue
        kept.append({
            "messages": episode_to_messages(c["episode"]["events"]),
            "provenance": {
                "scenario_id": c["scenario_id"],
                "agent_version": report["agent_version"],
                "dataset_version": report["dataset_version"],
                "env_version": report["env_version"],
                "judge_version": report["judge_version"],
                "reward": c["reward"],
            },
        })
    return kept, skipped


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("reports", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    rows, totals = [], {"failed": 0, "hard": 0, "test_split": 0}
    for p in args.reports:
        kept, skipped = export(json.loads(p.read_text(encoding="utf-8")))
        rows += kept
        for k, v in skipped.items():
            totals[k] += v
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    print(json.dumps({"written": len(rows), "skipped": totals, "out": str(args.out)}))


if __name__ == "__main__":
    main()
