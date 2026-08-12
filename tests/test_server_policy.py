import copy
import importlib.util
import json
from datetime import datetime, timedelta, timezone
from tempfile import TemporaryDirectory
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = PROJECT_ROOT / "server.py"
SPEC = importlib.util.spec_from_file_location("git_ai_control_server", SERVER_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(SERVER)


def example_policy():
    return json.loads((PROJECT_ROOT / "policy.example.json").read_text(encoding="utf-8"))


class ServerPolicyTests(unittest.TestCase):
    def test_preserves_repository_plugin_addition_order(self):
        policy = example_policy()
        additional_plugin = copy.deepcopy(policy["plugins"][0])
        additional_plugin["id"] = "gitlab"
        additional_plugin["name"] = "GitLab 仓库"
        additional_plugin["match"] = {"hosts": ["gitlab.com"]}
        policy["plugins"].append(additional_plugin)

        normalized = SERVER.validate_policy_config(policy)

        self.assertEqual([plugin["id"] for plugin in normalized["plugins"]], ["github", "gitlab"])
        self.assertEqual(normalized["version"], 2)
        self.assertFalse(normalized["plugins"][0]["match"]["all_repositories"])
        self.assertEqual(normalized["plugins"][0]["priority"], 100)

    def test_appends_repository_plugin_after_existing_plugin_types(self):
        policy = example_policy()
        additional_plugin = copy.deepcopy(policy["plugins"][0])
        additional_plugin["id"] = "gitlab"
        additional_plugin["name"] = "GitLab 仓库"
        additional_plugin["match"] = {"hosts": ["gitlab.com"]}
        policy["plugins"].append(additional_plugin)
        policy["plugin_order"] = [
            "repository:github",
            "skill_filter",
            "repository:gitlab",
        ]

        normalized = SERVER.validate_policy_config(policy)

        self.assertEqual(
            normalized["plugin_order"],
            ["repository:github", "skill_filter", "repository:gitlab"],
        )

    def test_migrates_legacy_policy_with_new_plugin_defaults(self):
        normalized = SERVER.validate_policy_config(example_policy())

        self.assertEqual(normalized["version"], 2)
        self.assertFalse(normalized["sensitive_data_policy"]["installed"])
        self.assertEqual(normalized["sensitive_data_policy"]["action"], "redact")
        self.assertFalse(normalized["agent_model_policy"]["installed"])
        self.assertNotIn("usage_dashboard", normalized)
        self.assertEqual(normalized["plugin_order"], ["repository:github", "skill_filter"])

    def test_rejects_more_than_thirty_two_repository_plugins(self):
        policy = example_policy()
        template = policy["plugins"][0]
        policy["plugins"] = [
            {**template, "id": f"repository-{index}", "name": f"仓库插件 {index}"}
            for index in range(1, 34)
        ]

        with self.assertRaisesRegex(SERVER.ConfigError, "最多配置 32 个"):
            SERVER.validate_policy_config(policy)

    def test_reads_only_recent_filter_audit_events(self):
        now = datetime(2026, 8, 12, 12, tzinfo=timezone.utc)
        with TemporaryDirectory() as directory:
            audit_path = Path(directory) / "filter_audit.jsonl"
            audit_path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "timestamp": "2026-08-12T11:30:00Z",
                                "eventType": "skill",
                                "reason": "skill_pattern",
                                "plugin": "github",
                                "repositories": ["github.com/example/recent"],
                                "skills": ["cloudflare-deploy"],
                            }
                        ),
                        json.dumps(
                            {
                                "timestamp": (now - timedelta(hours=25)).isoformat(),
                                "eventType": "skill",
                                "reason": "skill_pattern",
                                "repositories": ["github.com/example/expired"],
                                "skills": ["expired-skill"],
                            }
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            original_path = SERVER.FILTER_AUDIT_PATH
            try:
                SERVER.FILTER_AUDIT_PATH = audit_path
                since, events = SERVER.read_filter_audit_events(now)
            finally:
                SERVER.FILTER_AUDIT_PATH = original_path

        self.assertEqual(since, "2026-08-11T12:00:00Z")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["repositories"], ["github.com/example/recent"])
        self.assertEqual(events[0]["skills"], ["cloudflare-deploy"])


if __name__ == "__main__":
    unittest.main()
