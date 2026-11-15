#!/usr/bin/env python3
"""Routing regression: audit CI must use the pinned SWA client, not the Docker action."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SWITCH = "${{ vars.CI_RUNNER && fromJSON(vars.CI_RUNNER) || 'ubuntu-latest' }}"


def job_block(text: str, job: str) -> str:
    marker = f"\n  {job}:\n"
    assert marker in text, f"missing job {job}"
    block = text.split(marker, 1)[1]
    nxt = re.search(r"\n  [A-Za-z0-9_-]+:\s*\n", block)
    return block[: nxt.start()] if nxt else block


def main() -> None:
    deploy = (ROOT / ".github/workflows/deploy.yml").read_text()
    assert "types: [opened, synchronize, reopened, closed]" in deploy, "closed trigger missing"
    for job in ("checks", "deploy", "preview_contrast", "close_preview"):
        assert f"runs-on: {SWITCH}" in job_block(deploy, job), job
    assert "Azure/static-web-apps-deploy" not in deploy
    deploy_job = job_block(deploy, "deploy")
    assert "/opt/swa/StaticSitesClient upload" in deploy_job
    assert "test -x /opt/swa/StaticSitesClient" in deploy_job
    assert "INPUT_AZURE_STATIC_WEB_APPS_API_TOKEN" in deploy_job
    assert "INPUT_SKIP_DEPLOY_ON_MISSING_SECRETS" in deploy_job
    assert "Package the static site for upload" in deploy_job
    assert "INPUT_APP_LOCATION: 'swa-site'" in deploy_job
    close_job = job_block(deploy, "close_preview")
    assert "/opt/swa/StaticSitesClient close" in close_job
    assert "test -x /opt/swa/StaticSitesClient" in close_job
    assert "actions/checkout" not in close_job
    assert "needs.deploy.outputs.preview_url" in job_block(deploy, "preview_contrast")
    sync = (ROOT / ".github/workflows/sync-catalog.yml").read_text()
    assert f"runs-on: {SWITCH}" in job_block(sync, "sync")
    print("workflow routing OK")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        sys.exit(1)
