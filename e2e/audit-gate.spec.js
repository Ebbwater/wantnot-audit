// Regression: the audit report stays ungated; only the AI-insights (Wanda) panel asks
// for an email. Owner decision 2026-11-11 keeps the capture point there.
//
// The report is the product. A visitor who imports a valid export sees the full
// costed breakdown with no address supplied and no storage primed. The Wanda panel
// is the only place that asks for one, and it returns nothing until it has a real
// address: the page refuses locally, and the API refuses with 400
// {"error":"Valid email is required to unlock insights"}.
//
// Offline, and CSP-safe. The API is answered by a fixture route, never the deployed
// host — and that route is registered on **the API base the served config.js names**,
// not on a host of this file's invention.
//
// WHY THAT DISTINCTION MATTERS. The deployed preview serves `Content-Security-Policy`
// as a response header (`staticwebapp.config.json` → `globalHeaders`), and its
// `connect-src` names the real Functions host. `python3 -m http.server` serves no CSP
// at all. An earlier draft parked the fixture on `https://fixture.invalid`, which the
// browser refused *before* any route was consulted:
//
//   Connecting to 'https://fixture.invalid/api/audit/insights' violates the following
//   Content-Security-Policy directive: "connect-src 'self' https://graph.microsoft.com
//   https://login.microsoftonline.com https://func-wantnot-4dc52f.azurewebsites.net
//   https://wantnot.ebbwater.net https://*.azurewebsites.net"
//
// So the panel's catch block reported "Failed to fetch" and the spec passed locally
// while failing on the preview. Using the environment's own base removes the invented
// host: whatever the environment's CSP permits is what the page actually calls.
//
// Two mechanisms from that draft were measured and are gone rather than kept as
// reassurance:
//   * A CORS preflight branch. The page emits only `POST .../api/audit/insights` —
//     no `OPTIONS` at all — and Chromium does not preflight a fulfilled route.
//   * `access-control-allow-*` headers. A control with none of them still read the
//     body, so they were never load-bearing under interception. (They are real for a
//     genuine cross-origin fetch; this spec never makes one.)
const { test, expect } = require("@playwright/test");

const USERS_CSV = [
  "User principal name,Display name,Sign-in blocked,Licenses,Last sign-in,Created",
  "disabled@example.test,Disabled Example,Yes,SPE_E3,2020-01-01,2020-01-01",
  "dormant@example.test,Dormant Example,No,SPE_E3,2020-01-01,2020-01-01",
  "never@example.test,Never Example,No,SPE_E3,,2020-01-01",
  `active@example.test,Active Example,No,SPE_E3,${new Date().toISOString()},2020-01-01`,
].join("\r\n");
const LICENSES_CSV = "License,Purchased,Assigned\r\nSPE_E3,7,4\r\n";

// The deployed API's real refusal, quoted so the fixture cannot drift from it.
const REFUSAL = { error: "Valid email is required to unlock insights" };

// Matched against the path only. The origin is whatever config.js names, so this
// cannot silently stop matching if the API host moves.
const INSIGHTS = /\/api\/audit\/insights$/;

// Every intercepted request to the insights endpoint, in order. Used both to assert
// that nothing leaked and — critically — that the route actually fired, so a stub
// that stopped matching fails instead of passing vacuously.
function collectInsights(page) {
  const calls = [];
  page.on("request", (request) => {
    if (INSIGHTS.test(new URL(request.url()).pathname)) {
      calls.push({ method: request.method(), url: request.url(), post: request.postData() || "" });
    }
  });
  return calls;
}

// Answer the insights endpoint with `reply`, a function of the parsed body.
async function stubInsights(page, reply) {
  await page.route(INSIGHTS, async (route) => {
    const request = route.request();
    let body = {};
    try { body = JSON.parse(request.postData() || "{}"); } catch { body = {}; }
    const answer = reply(body, request);
    await route.fulfill({
      status: answer.status,
      contentType: "application/json",
      body: JSON.stringify(answer.body),
    });
  });
}

// A configured, signed-out boundary. Two things are forced and nothing else:
//
//   * `WANTNOT_AUDIT_CLIENT_ID`, because the committed config.js carries an empty
//     placeholder (the real one is injected at deploy) and an empty client ID parks
//     the page in its "not configured yet" state without ever rendering the import
//     UI. This is the only value that has to be faked for the page to boot.
//   * The MSAL CDN and the webfonts, so the run makes no outbound request. Neither
//     decides anything this spec asserts.
//
// `WANTNOT_API_BASE` is passed through exactly as the environment serves it.
async function openAudit(page) {
  await page.route("**/config.js", async (route) => {
    const served = await route.fetch();
    const text = await served.text();
    const patched = text.replace(
      /window\.WANTNOT_AUDIT_CLIENT_ID\s*=\s*'[^']*'/,
      "window.WANTNOT_AUDIT_CLIENT_ID='gate-test-client'");
    // Fail loudly rather than serve a config the page would reject.
    if (patched === text) throw new Error("config.js carries no WANTNOT_AUDIT_CLIENT_ID to override");
    await route.fulfill({ response: served, body: patched });
  });
  await page.route(/https:\/\/(alcdn\.msauth\.net|cdn\.jsdelivr\.net)\/.*msal-browser.*\.js/, (route) => route.fulfill({
    contentType: "application/javascript",
    body: "window.msal = { PublicClientApplication: class { async handleRedirectPromise() { return null; } getAllAccounts() { return []; } addEventCallback() {} async initialize() {} } };",
  }));
  await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/, (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.goto("/");
  await expect(page.locator("#impGo")).toBeVisible();
  // The base the SERVED config.js names — read back rather than assumed, so the
  // reachability precondition below is about this environment and not about a value
  // this file wrote.
  const apiBase = await page.evaluate(() => window.WANTNOT_API_BASE || "");
  return { apiBase };
}

test.beforeEach(async ({ page }) => {
  // No storage primed anywhere: an accidental "we remembered your email" path would
  // otherwise make the ungated assertion below prove nothing.
  await page.addInitScript(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
});

test("REGRESSION the full report renders with no email and no storage primed", async ({ page }) => {
  const insights = collectInsights(page);
  await stubInsights(page, () => ({ status: 400, body: REFUSAL }));
  await openAudit(page);

  // Nothing on the page asks for an address before the report exists.
  expect(await page.locator("input[type=email]").count(),
    "no email field is offered before the report renders").toBe(0);

  await page.setInputFiles("#impUsers", { name: "users.csv", mimeType: "text/csv", buffer: Buffer.from(USERS_CSV) });
  await page.setInputFiles("#impLic", { name: "lic.csv", mimeType: "text/csv", buffer: Buffer.from(LICENSES_CSV) });
  await page.locator("#impGo").click();

  // Assert on what the report actually produces, not on a container existing.
  const hero = page.locator(".hero-figure").first();
  await expect(hero, "the report renders its headline figure").toBeVisible();
  await expect(hero).toContainText("$");
  await expect(page.locator("#view h2", { hasText: "Findings" })).toBeVisible();
  await expect(page.locator("#view h2", { hasText: "License inventory" })).toBeVisible();
  expect(await page.locator("#fBody tr.grp-head").count(),
    "the findings table is populated, not empty").toBeGreaterThan(0);
  await expect(page.locator("#csv"), "the CSV download is offered").toBeVisible();

  // The report did not ask for an address and did not call the insights endpoint.
  // An email field does exist on the page — the panel's own capture point — so the
  // invariant is that every one of them sits inside that panel. A field that is not
  // in #wanda, or content withheld behind one, is a report gate.
  expect(insights.map((call) => call.post), "rendering the report calls no insights endpoint").toEqual([]);
  const stray = await page.locator("input[type=email]").evaluateAll(
    (els) => els.filter((e) => !e.closest("#wanda")).length);
  expect(stray, "every email field on the page belongs to the AI-insights panel").toBe(0);
});

test("REGRESSION the AI-insights panel returns nothing until an email is supplied", async ({ page }) => {
  const insights = collectInsights(page);
  // Default stub: refusal for anything the page manages to send. Inline routes below
  // re-register for the individual cases; Playwright runs the LAST registration
  // first (measured), so each case's route is the one that answers.
  await stubInsights(page, () => ({ status: 400, body: REFUSAL }));
  const loaded = await openAudit(page);

  await page.setInputFiles("#impUsers", { name: "users.csv", mimeType: "text/csv", buffer: Buffer.from(USERS_CSV) });
  await page.setInputFiles("#impLic", { name: "lic.csv", mimeType: "text/csv", buffer: Buffer.from(LICENSES_CSV) });
  await page.locator("#impGo").click();
  await expect(page.locator("#wanda")).toBeVisible();

  // The gate is only meaningful where the panel can reach the API at all. On a
  // headerless local server that is guaranteed; on the deployed preview it holds only
  // because the served CSP permits the configured base. Assert it rather than assume
  // it, so a CSP that stopped permitting the API fails here with its own message
  // instead of reappearing as an unexplained "Failed to fetch".
  const reach = await page.evaluate(async (path) => {
    try {
      const response = await fetch(window.WANTNOT_API_BASE + path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      return { ok: true, status: response.status };
    } catch (error) {
      return { ok: false, message: String(error && error.message ? error.message : error) };
    }
  }, "/api/audit/insights");
  expect(reach.ok,
    `the page's configured API base (${loaded.apiBase}) must be reachable from this origin; `
    + `a served CSP that does not permit it makes every assertion below meaningless. Got: ${reach.message}`).toBe(true);
  // The probe above is a request to the same endpoint, and it is deliberately not the
  // panel's. Drop it so the assertions below are about what a click sends.
  insights.length = 0;

  // No address: the panel refuses and shows no content, and sends nothing outward.
  await expect(page.locator("#wandaOut")).toBeHidden();
  await page.locator("#wandaGo").click();
  await expect(page.locator("#wandaErr")).toHaveText(/Enter a valid work email\./);
  await expect(page.locator("#wandaOut"), "no insights content without an email").toBeHidden();
  expect(insights.map((call) => call.post), "an empty address never reaches the API").toEqual([]);

  // An invalid address is still refused, locally.
  await page.fill("#wandaEmail", "not-an-email");
  await page.locator("#wandaGo").click();
  await expect(page.locator("#wandaErr")).toHaveText(/Enter a valid work email\./);
  await expect(page.locator("#wandaOut")).toBeHidden();
  expect(insights.map((call) => call.post), "a malformed address never reaches the API").toEqual([]);

  // The API's own refusal still yields no content: the panel surfaces it and stays empty.
  // (Fixture answers 400 with the deployed body; the page must not render anything.)
  await stubInsights(page, () => ({ status: 400, body: REFUSAL }));
  await page.fill("#wandaEmail", "visitor@example.test");
  await page.locator("#wandaGo").click();
  await expect(page.locator("#wandaErr")).toHaveText(REFUSAL.error);
  await expect(page.locator("#wandaOut"), "an API refusal renders no insights").toBeHidden();

  // Positive control: with a valid address the panel does return content, so the
  // assertions above are about the gate and not about a panel that never works.
  // It also proves the fixture route is genuinely wired — if the stub had stopped
  // matching, no content could ever appear and the negative assertions above would
  // have been passing for the wrong reason.
  await stubInsights(page, () => ({
    status: 200, body: { reply: "FIXTURE NARRATIVE", source: "deterministic", grounded: true },
  }));
  await page.locator("#wandaGo").click();
  await expect(page.locator("#wandaOut")).toBeVisible();
  await expect(page.locator("#wandaOut")).toContainText("FIXTURE NARRATIVE");
  expect(insights.length, "the valid-address click reached the fixture route").toBeGreaterThan(0);
  expect(insights.every((call) => call.method === "POST"),
    "the panel sends a plain POST, so no preflight is involved").toBe(true);
});
