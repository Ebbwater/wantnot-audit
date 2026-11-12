// Regression: the audit report stays ungated; only the AI-insights (Wanda) panel asks
// for an email. Owner decision 2026-11-11 keeps the capture point there.
//
// The report is the product. A visitor who imports a valid export sees the full
// costed breakdown with no address supplied and no storage primed. The Wanda panel
// is the only place that asks for one, and it returns nothing until it has a real
// address: the page refuses locally, and the API refuses with 400
// {"error":"Valid email is required to unlock insights"}.
//
// Offline: the API is answered by a fixture route, never the deployed host.
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

async function openAudit(page) {
  // A configured, signed-out boundary: the repo's config.js is a placeholder and
  // the MSAL CDN must not decide whether the import UI renders. Rendering is real.
  await page.route("**/config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "window.WANTNOT_AUDIT_CLIENT_ID='gate-test-client';window.WANTNOT_API_BASE='https://fixture.invalid';",
  }));
  await page.route(/https:\/\/(alcdn\.msauth\.net|cdn\.jsdelivr\.net)\/.*msal-browser.*\.js/, (route) => route.fulfill({
    contentType: "application/javascript",
    body: "window.msal = { PublicClientApplication: class { async handleRedirectPromise() { return null; } getAllAccounts() { return []; } addEventCallback() {} async initialize() {} } };",
  }));
  await page.goto("/");
  await expect(page.locator("#impGo")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  // No storage primed anywhere: an accidental "we remembered your email" path would
  // otherwise make the ungated assertion below prove nothing.
  await page.addInitScript(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
});

test("REGRESSION the full report renders with no email and no storage primed", async ({ page }) => {
  const insightsCalls = [];
  await page.route(/\/api\/audit\/insights$/, (route) => {
    insightsCalls.push(route.request().postData() || "");
    return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify(REFUSAL) });
  });
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
  expect(insightsCalls, "rendering the report calls no insights endpoint").toEqual([]);
  const stray = await page.locator("input[type=email]").evaluateAll(
    (els) => els.filter((e) => !e.closest("#wanda")).length);
  expect(stray, "every email field on the page belongs to the AI-insights panel").toBe(0);
});

test("REGRESSION the AI-insights panel returns nothing until an email is supplied", async ({ page }) => {
  const posts = [];
  await page.route(/\/api\/audit\/insights$/, (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    posts.push(body.email || "");
    const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((body.email || "").trim());
    return route.fulfill(ok
      ? { status: 200, contentType: "application/json", body: JSON.stringify({ reply: "FIXTURE NARRATIVE", source: "deterministic", grounded: true }) }
      : { status: 400, contentType: "application/json", body: JSON.stringify(REFUSAL) });
  });
  await openAudit(page);

  await page.setInputFiles("#impUsers", { name: "users.csv", mimeType: "text/csv", buffer: Buffer.from(USERS_CSV) });
  await page.setInputFiles("#impLic", { name: "lic.csv", mimeType: "text/csv", buffer: Buffer.from(LICENSES_CSV) });
  await page.locator("#impGo").click();
  await expect(page.locator("#wanda")).toBeVisible();

  // No address: the panel refuses and shows no content, and sends nothing outward.
  await expect(page.locator("#wandaOut")).toBeHidden();
  await page.locator("#wandaGo").click();
  await expect(page.locator("#wandaErr")).toHaveText(/Enter a valid work email\./);
  await expect(page.locator("#wandaOut"), "no insights content without an email").toBeHidden();
  expect(posts, "an empty address never reaches the API").toEqual([]);

  // An invalid address is still refused, locally.
  await page.fill("#wandaEmail", "not-an-email");
  await page.locator("#wandaGo").click();
  await expect(page.locator("#wandaErr")).toHaveText(/Enter a valid work email\./);
  await expect(page.locator("#wandaOut")).toBeHidden();
  expect(posts, "a malformed address never reaches the API").toEqual([]);

  // The API's own refusal still yields no content: the panel surfaces it and stays empty.
  // (Fixture answers 400 with the deployed body; the page must not render anything.)
  await page.fill("#wandaEmail", "visitor@example.test");
  await page.route(/\/api\/audit\/insights$/, (route) => route.fulfill({
    status: 400, contentType: "application/json", body: JSON.stringify(REFUSAL),
  }));
  await page.locator("#wandaGo").click();
  await expect(page.locator("#wandaErr")).toHaveText(REFUSAL.error);
  await expect(page.locator("#wandaOut"), "an API refusal renders no insights").toBeHidden();

  // Positive control: with a valid address the panel does return content, so the
  // assertions above are about the gate and not about a panel that never works.
  await page.route(/\/api\/audit\/insights$/, (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ reply: "FIXTURE NARRATIVE", source: "deterministic", grounded: true }),
  }));
  await page.locator("#wandaGo").click();
  await expect(page.locator("#wandaOut")).toBeVisible();
  await expect(page.locator("#wandaOut")).toContainText("FIXTURE NARRATIVE");
});
