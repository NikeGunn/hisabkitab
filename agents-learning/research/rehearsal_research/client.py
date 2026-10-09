"""HTTP client for the Rehearsal Lab RL API (stdlib only)."""
from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass


@dataclass(frozen=True)
class DecisionPoint:
    done: bool
    features: list[int] | None
    verdict: dict | None


class LabClient:
    def __init__(self, base_url: str = "http://127.0.0.1:8820", token: str | None = None) -> None:
        self.base = base_url.rstrip("/")
        self.token = token

    def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        req = urllib.request.Request(
            self.base + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"content-type": "application/json", **({"authorization": f"Bearer {self.token}"} if self.token else {})},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())

    def spec(self) -> dict:
        return self._call("GET", "/rl/spec")

    def scenarios(self, split: str) -> list[str]:
        return self._call("GET", f"/rl/scenarios?split={split}")["ids"]

    def reset(self, scenario_id: str) -> tuple[str, DecisionPoint]:
        r = self._call("POST", "/rl/reset", {"scenario_id": scenario_id})
        return r["session"], DecisionPoint(r["done"], r["features"], r["verdict"])

    def step(self, session: str, skill: int) -> DecisionPoint:
        r = self._call("POST", "/rl/step", {"session": session, "skill": int(skill)})
        return DecisionPoint(r["done"], r["features"], r["verdict"])

    def report_training_run(self, payload: dict) -> str:
        return self._call("POST", "/lab/training-runs", payload)["id"]
