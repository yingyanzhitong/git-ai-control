import importlib.util
import json
from datetime import datetime, timedelta, timezone
from tempfile import TemporaryDirectory
import unittest
from pathlib import Path


RUNTIME_PATH = (
    Path(__file__).resolve().parents[1]
    / "plugins"
    / "upload-filter"
    / "plugin_filter_runtime.py"
)
SPEC = importlib.util.spec_from_file_location("plugin_filter_runtime", RUNTIME_PATH)
RUNTIME = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(RUNTIME)


class UploadFilterRuntimeTests(unittest.TestCase):
    def test_pause_blocks_all_known_git_ai_events_before_plugin_rules(self):
        policy = RUNTIME.clone_default_policy()
        policy["git_ai_enabled"] = False

        decision = RUNTIME.evaluate_request(
            "/token-usage",
            {"repository": "github.com/example/private-repository"},
            config=policy,
        )

        self.assertTrue(decision["blocked"])
        self.assertEqual(decision["reason"], "git_ai_paused")

    def test_legacy_policy_without_global_state_remains_enabled(self):
        policy = RUNTIME.clone_default_policy()
        policy.pop("git_ai_enabled")

        decision = RUNTIME.evaluate_request(
            "/token-usage",
            {"repository": "gitlab.example.com/example/project"},
            config=policy,
        )

        self.assertFalse(decision["blocked"])

    def test_specific_repository_rule_wins_over_global_rule(self):
        policy = RUNTIME.clone_default_policy()
        global_rule = {
            **policy["plugins"][0],
            "id": "global",
            "match": {
                "all_repositories": True,
                "hosts": [],
                "repositories": [],
                "directories": [],
                "branches": [],
            },
            "priority": 1000,
            "allow": {**policy["plugins"][0]["allow"], "token": False},
        }
        specific_rule = {
            **policy["plugins"][0],
            "id": "github-main",
            "priority": 1,
            "match": {
                "all_repositories": False,
                "hosts": ["github.com"],
                "repositories": [],
                "directories": [],
                "branches": ["main"],
            },
            "allow": {**policy["plugins"][0]["allow"], "token": True},
        }
        policy["plugins"] = [global_rule, specific_rule]

        decision = RUNTIME.evaluate_request(
            "/token-usage",
            {"repository": "github.com/example/project", "branch": "main"},
            config=policy,
        )

        self.assertFalse(decision["blocked"])
        self.assertEqual(decision["plugin"], "github-main")

    def test_sensitive_content_is_redacted_before_forwarding(self):
        policy = RUNTIME.clone_default_policy()
        policy["plugins"] = []
        policy["sensitive_data_policy"] = {
            **policy["sensitive_data_policy"],
            "installed": True,
            "enabled": True,
            "event_types": {**policy["sensitive_data_policy"]["event_types"], "agent": True},
        }

        decision = RUNTIME.evaluate_request(
            "/agent-usage",
            {"note": "password=super-secret-value", "agent": "codex"},
            config=policy,
        )

        self.assertFalse(decision["blocked"])
        self.assertIn("[已脱敏:credential]", decision["payload"]["note"])
        self.assertEqual(decision["findings"]["sensitive"], ["credential"])

    def test_agent_model_block_mode_rejects_unapproved_values(self):
        policy = RUNTIME.clone_default_policy()
        policy["plugins"] = []
        policy["agent_model_policy"] = {
            **policy["agent_model_policy"],
            "installed": True,
            "enabled": True,
            "mode": "block",
            "allowed_agents": ["codex"],
            "allowed_models": ["gpt-5*"],
        }

        decision = RUNTIME.evaluate_request(
            "/agent-usage",
            {"agentName": "unknown-agent", "model": "other-model"},
            config=policy,
        )

        self.assertTrue(decision["blocked"])
        self.assertEqual(decision["reason"], "agent_model_policy")
        self.assertEqual(decision["findings"], ["unapproved_agent", "unapproved_model"])

    def test_recent_directory_skill_is_held_for_twenty_four_hours(self):
        policy = RUNTIME.clone_default_policy()
        policy["plugins"] = []
        now = datetime(2026, 9, 9, 12, tzinfo=timezone.utc)
        with TemporaryDirectory() as directory:
            state_path = Path(directory) / "recent_skill_holds.json"
            original_created_at = RUNTIME.directory_created_at
            try:
                RUNTIME.directory_created_at = lambda _: now - timedelta(days=1)
                first = RUNTIME.recent_directory_skill_guard(
                    {"cwd": directory, "skillName": "floorplan-digitization"},
                    policy["skill_policy"],
                    now=now,
                    state_path=state_path,
                )
                state = json.loads(state_path.read_text(encoding="utf-8"))
                released = RUNTIME.recent_directory_skill_guard(
                    {"cwd": directory, "skillName": "floorplan-digitization"},
                    policy["skill_policy"],
                    now=now + timedelta(hours=24),
                    state_path=state_path,
                )
            finally:
                RUNTIME.directory_created_at = original_created_at

        self.assertEqual(first, "recent_directory_skill_hold")
        self.assertIsNone(released)
        hold = next(iter(state["holds"].values()))
        self.assertEqual(hold["skill"], "floorplan-digitization")
        self.assertEqual(hold["directory"], str(Path(directory).resolve()))

    def test_recent_directory_skill_allowlist_bypasses_hold_and_blocklist_wins(self):
        policy = RUNTIME.clone_default_policy()
        policy["skill_policy"]["recent_directory_guard"] = {
            "enabled": True,
            "allowlist_patterns": ["floorplan-.*"],
            "blocklist_patterns": ["secret-skill"],
        }
        now = datetime(2026, 9, 9, 12, tzinfo=timezone.utc)
        with TemporaryDirectory() as directory:
            state_path = Path(directory) / "recent_skill_holds.json"
            original_created_at = RUNTIME.directory_created_at
            try:
                RUNTIME.directory_created_at = lambda _: now - timedelta(days=1)
                allowed = RUNTIME.recent_directory_skill_guard(
                    {"cwd": directory, "skillName": "floorplan-digitization"},
                    policy["skill_policy"],
                    now=now,
                    state_path=state_path,
                )
                blocked = RUNTIME.recent_directory_skill_guard(
                    {"cwd": directory, "skillName": "secret-skill"},
                    policy["skill_policy"],
                    now=now,
                    state_path=state_path,
                )
            finally:
                RUNTIME.directory_created_at = original_created_at

        self.assertIsNone(allowed)
        self.assertEqual(blocked, "recent_directory_skill_blocklist")

    def test_records_recent_filtered_repository_and_skill_without_url_credentials(self):
        with TemporaryDirectory() as directory:
            audit_path = Path(directory) / "filter_audit.jsonl"
            original_path = RUNTIME.FILTER_AUDIT_PATH
            try:
                RUNTIME.FILTER_AUDIT_PATH = audit_path
                RUNTIME.record_filter_event(
                    "/skill-usage",
                    {
                        "repository": "https://token@example@git.example.com/team/project.git?access_token=secret#fragment",
                        "skillName": "cloudflare-deploy",
                    },
                    "skill_pattern",
                    "github",
                )
                events = RUNTIME.read_filter_audit_events(path=audit_path)
            finally:
                RUNTIME.FILTER_AUDIT_PATH = original_path

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["repositories"], ["https://git.example.com/team/project.git"])
        self.assertEqual(events[0]["skills"], ["cloudflare-deploy"])
        self.assertEqual(events[0]["reason"], "skill_pattern")

    def test_ignores_expired_filter_audit_events(self):
        with TemporaryDirectory() as directory:
            audit_path = Path(directory) / "filter_audit.jsonl"
            expired = {
                "timestamp": (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat(),
                "eventType": "skill",
                "reason": "skill_pattern",
                "repositories": ["github.com/example/expired"],
                "skills": ["expired-skill"],
            }
            audit_path.write_text(json.dumps(expired) + "\n", encoding="utf-8")

            events = RUNTIME.read_filter_audit_events(path=audit_path)

        self.assertEqual(events, [])

if __name__ == "__main__":
    unittest.main()
