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
    assert "SWA_CLIENT_BUILD: a58ffd5ddfced557500b295844f2490acc313951" in deploy
    assert "SWA_CLIENT_SHA256: 0a3c8166b05fa427ed57386d9ba3d82d4f3f3e4f66fabc26c1f934fa705458fa" in deploy
    for job in ("checks", "deploy", "preview_contrast", "close_preview"):
        assert f"runs-on: {SWITCH}" in job_block(deploy, job), job
    assert "Azure/static-web-apps-deploy" not in deploy
    deploy_job = job_block(deploy, "deploy")
    assert "id: swa" in deploy_job
    assert "client=/opt/swa/StaticSitesClient" in deploy_job
    assert 'client="${RUNNER_TEMP:-/tmp}/StaticSitesClient"' in deploy_job
    assert "sha256sum -c -" in deploy_job
    assert '"$client" upload' in deploy_job
    assert "secrets.AZURE_STATIC_WEB_APPS_API_TOKEN_AUDIT" in deploy_job
    assert "secrets.GITHUB_TOKEN" in deploy_job
    assert "INPUT_SKIP_DEPLOY_ON_MISSING_SECRETS" in deploy_job
    assert "Package the static site for upload" in deploy_job
    assert "INPUT_APP_LOCATION: 'swa-site'" in deploy_job
    assert "config.js" in deploy_job and "brand" in deploy_job
    close_job = job_block(deploy, "close_preview")
    assert "client=/opt/swa/StaticSitesClient" in close_job
    assert 'client="${RUNNER_TEMP:-/tmp}/StaticSitesClient"' in close_job
    assert '"$client" close' in close_job
    assert "actions/checkout" not in close_job
    assert "github.event.pull_request.head.repo.full_name == github.repository" in close_job
    assert "github.event.pull_request.user.login != 'dependabot[bot]'" in close_job
    assert "timeout-minutes: 10" in close_job
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
