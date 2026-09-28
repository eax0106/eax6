"""Design log §31: the auto-creation tier ceiling defaults to the standard tier.

The ceiling is configuration, raised deliberately per deployment. Its default
is what every deployment gets when nobody sets it, so it is the policy.
"""

import pytest

from src.config import Settings


def test_ceiling_defaults_to_standard(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGENT_AUTO_CREATION_MAX_TIER", raising=False)
    monkeypatch.setenv("AUTH0_M2M_TOKEN_URL", "http://127.0.0.1:9/oauth/token")
    monkeypatch.setenv("AUTH0_M2M_AUDIENCE", "alter-engine")
    monkeypatch.setenv("AUTH0_M2M_CLIENT_ID", "test-client")
    monkeypatch.setenv("AUTH0_M2M_CLIENT_SECRET", "test-secret")

    assert Settings(_env_file=None).agent_auto_creation_max_tier == "STANDARD"  # type: ignore[call-arg]


def test_ceiling_is_raisable_by_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_AUTO_CREATION_MAX_TIER", "ADVANCED")
    monkeypatch.setenv("AUTH0_M2M_TOKEN_URL", "http://127.0.0.1:9/oauth/token")
    monkeypatch.setenv("AUTH0_M2M_AUDIENCE", "alter-engine")
    monkeypatch.setenv("AUTH0_M2M_CLIENT_ID", "test-client")
    monkeypatch.setenv("AUTH0_M2M_CLIENT_SECRET", "test-secret")

    assert Settings(_env_file=None).agent_auto_creation_max_tier == "ADVANCED"  # type: ignore[call-arg]
