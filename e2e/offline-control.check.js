// Positive control for the offline proof (tools/playwright.offline.config.js).
//
// A blackhole that silently does nothing lets every suite "pass offline" for
// the wrong reason. This test requires a real external host to FAIL to resolve
// under the same config, so the DNS block is demonstrated rather than claimed.
// It is NOT part of the normal gate: it only makes sense under the offline
// config, and must fail under the normal one — which is how its non-vacuity was
// established (the same probe with no browser flags returned a response instead
// of throwing). It IS run by `tools/check_all.sh --offline` together with the
// analytics suite, so the offline claim is re-established on demand rather than
// asserted in prose.
//
// The host probed is `example.com`: a neutral, documentation-reserved name, not
// a provider endpoint. Do NOT point this at an analytics vendor — a probe that
// succeeds there is a real outbound request to that vendor, which this work is
// not permitted to make.
const { test, expect } = require("@playwright/test");

test("the DNS blackhole is real: an external host cannot resolve", async ({ page }) => {
  const failure = await page.evaluate(async () => {
    try {
      await fetch("https://example.com/", { method: "GET", mode: "no-cors" });
      return null;
    } catch (err) {
      return String(err && err.message ? err.message : err);
    }
  });
  expect(failure, "an external host resolved and answered; the blackhole is not in force")
    .not.toBeNull();
  expect(failure.toLowerCase())
    .toMatch(/failed to fetch|networkerror|err_name_not_resolved|load failed/);
});
