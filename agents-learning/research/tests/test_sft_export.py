from rehearsal_research.sft_export import export


def case(split, passed, hard):
    events = [
        {"kind": "owner_message", "data": {"text": "Add this bill"}},
        {"kind": "tool_call", "data": {"name": "record_expense", "args": {"amount_paisa": 100}}},
        {"kind": "tool_result", "data": {"name": "record_expense", "data": {"saved": True}}},
        {"kind": "agent_message", "data": {"text": "Shall I save it?"}},
    ]
    return {"scenario_id": f"x/{split}", "split": split, "passed": passed, "hard": hard, "reward": 1.0, "episode": {"events": events}}


REPORT = {"agent_version": "a", "dataset_version": "d", "env_version": "e", "judge_version": "j"}


def test_only_verified_train_dev_episodes_are_exported():
    rows, skipped = export({**REPORT, "cases": [case("train", True, []), case("dev", True, []), case("dev", False, []), case("train", True, ["UNAPPROVED_SAVE"]), case("test", True, [])]})
    assert len(rows) == 2
    assert skipped == {"failed": 1, "hard": 1, "test_split": 1}


def test_conversation_shape():
    rows, _ = export({**REPORT, "cases": [case("train", True, [])]})
    roles = [m["role"] for m in rows[0]["messages"]]
    assert roles == ["user", "assistant", "tool", "assistant"]
    assert rows[0]["provenance"]["agent_version"] == "a"
