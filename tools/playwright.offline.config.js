// Playwright config for the OFFLINE proof: every external DNS name resolves to
// NOTFOUND, so any real egress attempt fails immediately instead of hanging.
//
// This is a reviewer/CI evidence wrapper, not the shipped gate config. The
// analytics suite fulfils the provider origin locally and stubs MSAL/fonts, so
// it should pass identically here; the point is that "runs offline" is
// demonstrated rather than claimed.
//
// 127.0.0.1 is excluded: the suite's own fixture servers and the static server
// bind there, and blocking loopback would break the harness rather than the
// network.
const path = require("node:path");
// This config lives in tools/, so both testDir and the webServer's working
// directory must be pinned to the repository root explicitly — Playwright
// resolves them relative to the config file, and a server rooted in tools/
// silently serves a directory listing with no page in it.
const ROOT = path.resolve(__dirname, "..");
const baseURL = process.env.PREVIEW_URL || "http://127.0.0.1:8902";
const python = process.env.AUDIT_TEST_PYTHON || "python3";

/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: path.resolve(ROOT, "e2e"),
  // `.check.js` files are deliberately outside the normal config's testMatch:
  // they are evidence wrappers that only make sense under this blackholed
  // config (a positive control asserting external DNS is blocked, and so on).
  testMatch: ["**/*.spec.js", "**/*.check.js"],
  timeout: 180000,
  retries: 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL,
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    launchOptions: {
      args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: process.env.PREVIEW_URL
    ? undefined
    : {
        command: `"${python}" -m http.server 8902 --bind 127.0.0.1`,
        cwd: ROOT,
        url: baseURL,
        reuseExistingServer: false,
        timeout: 15000,
      },
};
