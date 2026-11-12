// Analytics hook on the audit page — inert by default, one pageview when
// configured, and never a beacon without an answered consent banner.
//
// The audit page is served from THIS repository (the marketing repo's
// /audit.html is a 301 stub), so this is the only place the hook can actually
// fire. Every case runs offline: the provider origin is redirected into a
// local fake, so no request leaves the machine, no vendor account exists and no
// DNS lookup is needed.
//
// What this holds to account:
//   * EMPTY SITE ID (the shipped state, config.js unmodified): loading the page
//     produces no analytics *attempt* (observed at the fetch/sendBeacon
//     boundary), no request, no third-party script, no vendor global, and no
//     `data-analytics` attribute — including after the visitor answers Accept,
//     which is the one answer that would permit a send.
//   * NO CONSENT SEAM: with the banner script unavailable the hook must report
//     `no-consent-seam` and send nothing. This is the failure the card exists
//     to prevent, so it gets its own test rather than being implied.
//   * A TEST SITE ID: exactly one beacon, POST, to the configured provider's
//     endpoint, carrying the site id and a query-free URL — only after consent
//     is 'accept', and never for a visitor who rejects or has not answered.
//     These cases run against a DEPLOY CHECKOUT SERVED WITH ITS OWN CSP (see
//     e2e/fixtures/analytics-site.js), because `connect-src` is a document
//     response header: a test that stubs config.js on a server which sends no
//     CSP proves the hook's logic and nothing about the launch path.
//   * THE CSP GRANT IS REAL, twice over: tools/analytics_csp.py leaves the
//     config byte-identical with no site id and adds exactly that one origin to
//     connect-src (never script-src) when one is set; and the beacon is
//     observed to travel under that derived header, with a stripped-grant
//     negative control proving the header is what allows it.
//
// The static half doubles as the wiring gate: index.html losing the hook tag,
// or losing the banner that makes the tag able to fire, fails here.

/* global document:readonly, window:readonly, navigator:readonly */
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { deploySite, withoutOrigin } = require("./fixtures/analytics-site");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// Every analytics host worth naming, not only the endpoint this commit happens
// to reference: "no analytics request" must be asserted against a superset, or
// the test only proves the hook is not the one vendor it currently names.
const ANALYTICS_HOSTS = [
  "plausible.io",
  "usefathom.com",
  "fathomdns.com",
  "google-analytics.com",
  "googletagmanager.com",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "posthog.com",
  "clarity.ms",
  "umami.is",
  "matomo.cloud",
];

const isAnalytics = (url) => ANALYTICS_HOSTS.some((host) => url.includes(host));

// Obviously synthetic: no real account exists and nothing may reach a provider.
const TEST_SITE = "wantnot-audit-test-site-id";

const configWith = (provider, site) =>
  `window.WANTNOT_AUDIT_CLIENT_ID = 'audit-test-client-id';\n` +
  `window.WANTNOT_API_BASE = 'https://func-wantnot-4dc52f.azurewebsites.net';\n` +
  `window.WANTNOT_ANALYTICS = { provider: '${provider}', site: '${site}' };\n`;

// The audit page boots MSAL from a CDN and calls Graph. Neither is under test
// here, so the CDN is stubbed (the same shim e2e/contrast.spec.js uses, so both
// specs exercise one boundary) and every product endpoint is refused locally.
// Nothing in this file reaches the network: fonts, MSAL, Graph and the
// analytics origins are all answered here.
async function serveOffline(page) {
  await page.route(/https:\/\/(alcdn\.msauth\.net|cdn\.jsdelivr\.net)\/.*msal-browser.*\.js/, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body:
        "window.msal = { PublicClientApplication: class {" +
        " async handleRedirectPromise() { return null; }" +
        " getAllAccounts() { return []; } } };",
    }));
  await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/, (route) =>
    route.fulfill({ contentType: "text/css", body: "" }));
  await page.route(
    /https:\/\/(graph\.microsoft\.com|login\.microsoftonline\.com|[^/]+\.azurewebsites\.net)\//,
    (route) => route.abort());
}

// Records every beacon that reaches the wire and answers it locally, so the
// spec proves the call the hook makes without any egress.
async function captureBeacons(page) {
  const sent = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (isAnalytics(request.url())) {
      sent.push({ url: request.url(), method: request.method(), body: request.postData() });
      // 204: the provider saw it. No body, no real endpoint involved.
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fallback();
  });
  return sent;
}

// Records the hook's ATTEMPT to send, at the API boundary, before any browser
// network or CSP decision is made.
//
// This is not interchangeable with `captureBeacons`. A POST blocked by
// `connect-src` never becomes an observable network request: the browser
// refuses it before the network layer and Playwright's request events stay
// empty. So "no request was seen" cannot distinguish "the hook never tried"
// from "the hook tried and the header blocked it" — opposite conclusions. The
// pairing separates them: zero attempts proves inertness regardless of CSP, and
// one attempt with no beacon proves the CSP is what stopped it.
async function captureAttempts(page) {
  await page.addInitScript(() => {
    const attempts = [];
    Object.defineProperty(window, "__wantnotBeaconAttempts", {
      value: attempts,
      writable: false,
      configurable: true,
    });
    const record = (entry) => {
      try { attempts.push(entry); } catch (err) { /* never break the page */ }
    };

    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function (input, init) {
        const target = input && typeof input === "object" && "url" in input ? input.url : input;
        record({ via: "fetch", url: String(target), body: init && init.body });
        return originalFetch.apply(this, arguments);
      };
    }
    if (navigator && typeof navigator.sendBeacon === "function") {
      const originalBeacon = navigator.sendBeacon;
      navigator.sendBeacon = function (url, data) {
        record({ via: "sendBeacon", url: String(url), body: data });
        return originalBeacon.apply(this, arguments);
      };
    }
  });
}

const beaconAttempts = (page) => page.evaluate(() => window.__wantnotBeaconAttempts || []);

// Answer the banner before the page runs, which is what a returning visitor
// does; a first visit is covered separately by actually clicking the button.
async function presumeAnswer(page, state) {
  await page.addInitScript((value) => {
    try {
      window.localStorage.setItem("wantnot.consent", JSON.stringify({
        state: value,
        at: new Date().toISOString(),
      }));
    } catch (err) {
      // Nothing to do: the test asserts the outcome, not the storage.
    }
  }, state);
}

const seam = (page) => page.evaluate(() => ({
  enabled: window.WantNotAnalytics.enabled,
  provider: window.WantNotAnalytics.provider,
  state: window.WantNotAnalytics.state,
}));

const tracked = (page) =>
  page.evaluate(() => document.documentElement.getAttribute("data-analytics"));

test.describe("analytics is inert with no site id (the shipped state)", () => {
  // Guard the premise: if config.js ever ships a site id, this block stops
  // testing the default and must fail loudly.
  test("config.js ships an empty analytics site id and provider", () => {
    const config = read("config.js");
    expect(config).toContain("window.WANTNOT_ANALYTICS");
    expect(config).toContain("window.WANTNOT_ANALYTICS = { provider: '', site: '' };");
  });

  test("the shipped page makes no analytics request, even when consent is accepted", async ({ page }) => {
    await serveOffline(page);
    const sent = await captureBeacons(page);
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    // Recorded at the API boundary, so this holds with or without a CSP: an
    // inert hook must not even call fetch/sendBeacon.
    await captureAttempts(page);
    // Acceptance is the one answer that WOULD permit a send, so an inert hook
    // must stay silent under it — that is the strongest case, not the weakest.
    await presumeAnswer(page, "accept");

    await page.goto("/");
    await page.waitForLoadState("load");

    expect(await beaconAttempts(page), "the shipped page tried to send a beacon")
      .toEqual([]);
    expect(sent, "the shipped page sent an analytics beacon").toEqual([]);
    expect(requests.filter(isAnalytics), "the shipped page requested an analytics origin").toEqual([]);

    // No vendor global was defined by any of this.
    expect(await page.evaluate(() => [
      typeof window.gtag, typeof window.ga, typeof window.dataLayer,
      typeof window.analytics, typeof window.plausible, typeof window.fathom,
    ])).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined", "undefined"]);
    expect(await tracked(page)).toBeNull();

    // The seam reports the shipped state, not a configured-but-quiet one.
    expect(await seam(page)).toEqual({ enabled: false, provider: "", state: "inert" });
  });

  test("the shipped page is silent while served under its own committed CSP", async ({ page }) => {
    // Requirement that the inert half never rests on CSP being absent: serve
    // the same checkout with the committed CSP attached and re-prove silence.
    // The case above is stronger still (it asserts no attempt at all), but this
    // one removes the "it only passed because the local server sends no
    // header" objection outright.
    const site = await deploySite();
    try {
      expect(site.derivedCsp, "the deploy step changed the CSP with no site id")
        .toBe(site.committedCsp);
      await serveOffline(page);
      const sent = await captureBeacons(page);
      await captureAttempts(page);
      await presumeAnswer(page, "accept");

      const document_ = await page.goto(`${site.origin}/index.html`);
      await page.waitForLoadState("load");
      expect(document_.headers()["content-security-policy"]).toBe(site.committedCsp);

      expect(await beaconAttempts(page), "the inert checkout attempted a beacon").toEqual([]);
      expect(sent).toEqual([]);
      expect(await seam(page)).toEqual({ enabled: false, provider: "", state: "inert" });
    } finally {
      await site.close();
    }
  });

  test("the page fetches no script from another origin", async ({ page }) => {
    await serveOffline(page);
    const scripts = [];
    page.on("request", (request) => {
      if (request.resourceType() === "script") scripts.push(request.url());
    });
    await page.goto("/");
    await page.waitForLoadState("load");
    const origin = new URL(page.url()).origin;
    expect(scripts.filter((url) => new URL(url).origin !== origin))
      .toEqual([]);
  });

  test("the banner tells a visitor there is no tracking when there is none", async ({ page }) => {
    await serveOffline(page);
    await page.goto("/");
    const banner = page.locator("[data-consent]");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("No advertising cookie, no tracking between sites");
    // The copy is derived from the same config the hook reads, so it cannot
    // claim a measurement the site is not running.
    await expect(banner).not.toContainText("page view");
  });
});

// ── the configured cases: a deploy checkout served under its own CSP ────────
//
// WHY NOT `page.route("**/config.js")`. Setting a site id from the test is not
// enough to exercise the launch path, because `connect-src` is a header on the
// DOCUMENT response. Stubbing config.js leaves the served document's inert CSP
// in force, the browser refuses the beacon POST, and the assertion is only
// green where no CSP exists at all — which is exactly the local static server
// `python3 -m http.server` in playwright.config.js. That defect shipped once
// already in ebbwater/wantnot (PR #539: three "configured" cases failed on the
// hosting preview and passed locally) and is not repeated here.
//
// So every case below runs against the deploy checkout: the repository's served
// files plus the config.js the deploy workflow generates, `analytics_csp.py`
// applied exactly as the deploy job applies it, and a fixture server that emits
// the resulting `staticwebapp.config.json` globalHeaders — including the CSP
// derived from that same config.js — the way Azure Static Web Apps does. If the
// derivation goes missing or names the wrong origin, these cases fail.
test.describe("analytics renders one beacon when a site id is configured", () => {
  // [provider, the endpoint host the beacon goes to, the exact origin the deploy
  // step must grant in connect-src]. Fathom's endpoint lives on its CDN host, so
  // the grant is the CDN origin — the same origin the hook posts to, which is
  // what makes the grant sufficient rather than merely present.
  const PROVIDERS = [
    ["plausible", "plausible.io", "https://plausible.io"],
    ["fathom", "usefathom.com", "https://cdn.usefathom.com"],
  ];

  for (const [provider, host, grant] of PROVIDERS) {
    test(`${provider}: one beacon to the provider endpoint, allowed by the derived CSP`, async ({ page }) => {
      const site = await deploySite({ provider, site: TEST_SITE });
      try {
        await serveOffline(page);
        const sent = await captureBeacons(page);
        await presumeAnswer(page, "accept");

        const document_ = await page.goto(`${site.origin}/index.html`);
        await page.waitForLoadState("load");

        // The premise, asserted rather than assumed: the document response
        // really carried the CSP the deploy step derived, and that CSP really
        // grants the origin this hook posts to. A fixture that silently served
        // no header would make the rest of this test meaningless.
        const servedCsp = document_.headers()["content-security-policy"];
        expect(servedCsp, "the fixture document carried no CSP header").toBe(site.csp);
        const connect = servedCsp.split(";").map((d) => d.trim())
          .find((d) => d.startsWith("connect-src"));
        expect(connect, `derived CSP does not grant ${provider}'s origin ${grant}`)
          .toContain(grant);

        // Exactly one pageview: the hook is idempotent per page load.
        await expect.poll(() => sent.length, {
          message: `no ${provider} beacon fired with a site id configured under the derived CSP`,
          timeout: 5000,
        }).toBe(1);

        const beacon = sent[0];
        expect(beacon.method).toBe("POST");
        expect(beacon.url).toContain(host);
        const body = JSON.parse(beacon.body);
        expect(JSON.stringify(body)).toContain(TEST_SITE);
        // Origin + pathname and nothing else: the audit page accepts ?tenant=,
        // and a beacon must not turn a visitor's query string into a log line.
        expect(JSON.stringify(body)).not.toContain("?");
        expect(JSON.stringify(body)).not.toContain("#");

        // Activation is observable without a network capture.
        expect(await tracked(page)).toBe(provider);
        expect((await seam(page)).state).toBe("sent");
      } finally {
        await site.close();
      }
    });
  }

  test("a first-visit visitor who accepts sends exactly one beacon", async ({ page }) => {
    const site = await deploySite({ provider: "plausible", site: TEST_SITE });
    try {
      await serveOffline(page);
      const sent = await captureBeacons(page);

      await page.goto(`${site.origin}/index.html`);
      await page.waitForLoadState("load");

      // Unanswered on a first visit: the banner is up and nothing has been sent.
      await expect(page.locator("[data-consent]")).toBeVisible();
      expect(sent, "a beacon fired before the visitor answered").toEqual([]);
      expect((await seam(page)).state).toBe("awaiting-consent");

      await page.locator("[data-consent-accept]").click();
      await expect.poll(() => sent.length, { timeout: 5000 }).toBe(1);
      expect((await seam(page)).state).toBe("sent");
      // One answer, one pageview: a second answer cannot replay it.
      await page.locator("[data-consent-open]").click();
      await page.locator("[data-consent-accept]").click();
      await page.waitForTimeout(300);
      expect(sent.length).toBe(1);
    } finally {
      await site.close();
    }
  });

  test("a rejected visitor sends nothing even with a site id configured", async ({ page }) => {
    const site = await deploySite({ provider: "plausible", site: TEST_SITE });
    try {
      await serveOffline(page);
      const sent = await captureBeacons(page);
      await captureAttempts(page);
      await presumeAnswer(page, "reject");

      await page.goto(`${site.origin}/index.html`);
      await page.waitForLoadState("load");
      // Give a would-be beacon time to fire before asserting its absence.
      await page.waitForTimeout(500);

      expect(sent, "a rejected visitor was tracked").toEqual([]);
      // Not merely blocked by the header — never attempted.
      expect(await beaconAttempts(page), "a rejected visitor's beacon was attempted").toEqual([]);
      expect((await seam(page)).state).toBe("awaiting-consent");
      expect(await tracked(page)).toBeNull();
    } finally {
      await site.close();
    }
  });

  test("a visitor who rejects on the banner is never tracked, and Accept still works after", async ({ page }) => {
    const site = await deploySite({ provider: "plausible", site: TEST_SITE });
    try {
      await serveOffline(page);
      const sent = await captureBeacons(page);

      await page.goto(`${site.origin}/index.html`);
      await page.waitForLoadState("load");
      await page.locator("[data-consent-reject]").click();
      await page.waitForTimeout(400);
      expect(sent, "rejecting the banner still produced a beacon").toEqual([]);

      // The footer control reopens the banner, and a later Accept is honoured:
      // consent is changeable, and the answer that counts is the current one.
      await page.locator("[data-consent-open]").click();
      await expect(page.locator("[data-consent]")).toBeVisible();
      await page.locator("[data-consent-accept]").click();
      await expect.poll(() => sent.length, { timeout: 5000 }).toBe(1);
    } finally {
      await site.close();
    }
  });

  test("a configured hook with no consent seam reports it and sends nothing", async ({ page }) => {
    // The exact failure this card exists to prevent: a beacon wired into a page
    // that never asks, so it can never fire and never says why. Blocking the
    // banner is how that state is reachable, and it must be loud, not silent.
    const site = await deploySite({ provider: "plausible", site: TEST_SITE });
    try {
      await serveOffline(page);
      const sent = await captureBeacons(page);
      await page.route("**/consent.js", (route) => route.fulfill({
        contentType: "text/javascript",
        body: "/* banner unavailable */",
      }));
      await presumeAnswer(page, "accept");

      await page.goto(`${site.origin}/index.html`);
      await page.waitForLoadState("load");
      await page.waitForTimeout(400);

      expect(sent, "a hook with no consent seam still beacons").toEqual([]);
      expect(await seam(page)).toEqual({
        enabled: true,
        provider: "plausible",
        state: "no-consent-seam",
      });
    } finally {
      await site.close();
    }
  });

  test("an unknown provider is silent, and the deploy step refuses it outright", async ({ page }) => {
    // A typo must not fall through to a guess — and the derivation must fail
    // closed with it: an unrecognised provider is REFUSED by the deploy step
    // (non-zero exit before anything is published), so no build can serve a
    // hook whose beacon the CSP would block. Both halves are asserted.
    const site = await deploySite({ provider: "not-a-provider", site: TEST_SITE });
    try {
      expect(site.refused, "an unknown provider did not fail the deploy step").toBe(true);
      expect(site.derivedCsp, "an unknown provider nonetheless earned a CSP grant")
        .toBe(site.committedCsp);
      await serveOffline(page);
      const sent = await captureBeacons(page);
      await presumeAnswer(page, "accept");

      await page.goto(`${site.origin}/index.html`);
      await page.waitForLoadState("load");
      await page.waitForTimeout(400);

      expect(sent, "an unrecognised provider fell through to a request").toEqual([]);
      expect(await seam(page)).toEqual({ enabled: false, provider: "", state: "inert" });
      // A provider this build cannot ship does not get to claim measurement in
      // the banner either.
      await page.locator("[data-consent-open]").click();
      await expect(page.locator("[data-consent]")).not.toContainText("anonymous page view");
    } finally {
      await site.close();
    }
  });

  test("a beacon the network refuses reports send-failed, not sent", async ({ page }) => {
    // The failure a configured hook actually hits when the endpoint is down. It
    // must not be reported as delivered, and must not look like the visitor
    // never answered — different faults, different fixes. The derived CSP grants
    // the origin here, so the refusal is the endpoint's, not the document's:
    // exactly the case the CSP negative control below separates.
    const site = await deploySite({ provider: "plausible", site: TEST_SITE });
    try {
      await serveOffline(page);
      await page.route("**/*", (route) =>
        isAnalytics(route.request().url())
          ? route.abort("blockedbyclient")
          : route.fallback());
      await presumeAnswer(page, "accept");

      await page.goto(`${site.origin}/index.html`);
      await page.waitForLoadState("load");

      await expect.poll(() => page.evaluate(() => window.WantNotAnalytics.state), {
        message: "a refused beacon still reports sent",
        timeout: 5000,
      }).toBe("send-failed");
      expect(await tracked(page), "a failed send must not mark the page as tracked")
        .toBeNull();
    } finally {
      await site.close();
    }
  });

  test("THE DEFECT CLASS: the same configured build beacons with no CSP header but is blocked under the committed CSP", async ({ page }) => {
    // Why the harness had to change, demonstrated rather than asserted.
    //
    // Same checkout, same config.js with a site id, same hook. The only
    // difference is whether the document response carries a CSP header:
    //
    //   * served by a plain static server (`python3 -m http.server`, which is
    //     what playwright.config.js runs and what this suite used before) the
    //     beacon succeeds — one downhill POST, green;
    //   * served under the committed CSP, i.e. the launch misconfiguration where
    //     the grant was never derived, it is refused and nothing is delivered.
    //
    // The old harness therefore reported a pass for a configuration that
    // production blocks. Both halves run here so the blindness cannot silently
    // return: if a future change makes the no-CSP case stop beacons, or the
    // committed-CSP case start beacons, this test fails.
    const noHeader = await deploySite({ provider: "plausible", site: TEST_SITE, serveNoCsp: true });
    try {
      expect(noHeader.derivedCsp, "the derived CSP should carry the grant").toContain("https://plausible.io");
      await serveOffline(page);
      const sent = await captureBeacons(page);
      await presumeAnswer(page, "accept");

      const document_ = await page.goto(`${noHeader.origin}/index.html`);
      await page.waitForLoadState("load");
      // The premise: this response really carries no CSP.
      expect(document_.headers()["content-security-policy"]).toBeUndefined();

      await expect.poll(() => sent.length, {
        message: "with no CSP header the beacon should reach the wire — this half "
          + "demonstrates why a headerless harness passes a launch misconfiguration",
        timeout: 5000,
      }).toBe(1);
      expect((await seam(page)).state).toBe("sent");
    } finally {
      await noHeader.close();
    }

    // Now withhold the grant by serving the COMMITTED CSP (the inert header) on
    // the same configured build — exactly what production serves when the
    // derivation is skipped or broken.
    const withheld = await deploySite({
      provider: "plausible",
      site: TEST_SITE,
      cspTransform: () => JSON.parse(read("staticwebapp.config.json")).globalHeaders["Content-Security-Policy"],
    });
    try {
      expect(withheld.csp, "the withheld CSP must not grant the provider").not.toContain("https://plausible.io");
      await serveOffline(page);
      const sent = await captureBeacons(page);
      await captureAttempts(page);
      await presumeAnswer(page, "accept");

      const document_ = await page.goto(`${withheld.origin}/index.html`);
      await page.waitForLoadState("load");
      expect(document_.headers()["content-security-policy"]).toBe(withheld.csp);

      expect(sent, "a beacon fired under a CSP that withholds the grant").toEqual([]);
      await expect.poll(() => page.evaluate(() => window.WantNotAnalytics.state), {
        message: "a CSP-blocked beacon must report send-failed, not sent",
        timeout: 5000,
      }).toBe("send-failed");
      // ...and the hook DID try, so this is the header's doing.
      expect(await beaconAttempts(page)).toHaveLength(1);
    } finally {
      await withheld.close();
    }
  });

  test("NEGATIVE CONTROL: with the derived grant removed the beacon is blocked", async ({ page }) => {
    // The control that makes the cases above evidence rather than decoration.
    // Same checkout, same config.js, same synthetic provider — the ONLY
    // difference is the one `connect-src` token the deploy step added. If the
    // positive cases were passing for some reason other than that grant, this
    // control would still see a beacon and fail.
    const site = await deploySite({
      provider: "plausible",
      site: TEST_SITE,
      cspTransform: (csp) => withoutOrigin(csp, "https://plausible.io"),
    });
    try {
      expect(site.csp).not.toContain("https://plausible.io");
      expect(site.csp.split(";").length).toBe(site.derivedCsp.split(";").length);

      await serveOffline(page);
      const sent = await captureBeacons(page);
      await captureAttempts(page);
      await presumeAnswer(page, "accept");

      const document_ = await page.goto(`${site.origin}/index.html`);
      await page.waitForLoadState("load");
      expect(document_.headers()["content-security-policy"]).toBe(site.csp);

      // No beacon reached the wire, and the hook does not pretend otherwise: a
      // CSP-blocked POST must report the failure, never `sent`.
      await expect.poll(() => page.evaluate(() => window.WantNotAnalytics.state), {
        message: "a CSP-blocked beacon still reported a delivery state",
        timeout: 5000,
      }).toBe("send-failed");
      expect(sent, "a beacon fired despite the CSP grant being withheld").toEqual([]);

      // The attempt IS observed, with the beacon withheld. That pairing is what
      // makes this a control rather than a coincidence: the hook tried to send
      // exactly as it does in the positive cases, and the only difference in the
      // environment is the one connect-src token, so the header is demonstrably
      // what stopped it.
      const attempts = await beaconAttempts(page);
      expect(attempts, "the hook never attempted a beacon; the control proves nothing")
        .toHaveLength(1);
      expect(attempts[0].url).toContain("plausible.io");

      expect(await tracked(page), "a CSP-blocked beacon marked the page as tracked")
        .toBeNull();
      // The visitor answered; the failure is the header's, not consent's. Those
      // states must stay distinct or a launch misconfiguration reads as a
      // consent bug.
      expect((await seam(page)).state).not.toBe("sent");
    } finally {
      await site.close();
    }
  });
});

test.describe("analytics CSP grant (offline, through the real tool)", () => {
  // The committed staticwebapp.config.json is never changed by this work: the
  // grant is derived from the deployed config.js. So the tests drive the real
  // tool against a scratch checkout and read the result back.
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "wantnot-audit-csp-"));

  const applyTo = (configBody, extra = []) => {
    const dir = scratch();
    try {
      for (const name of ["staticwebapp.config.json"]) {
        fs.copyFileSync(path.join(ROOT, name), path.join(dir, name));
      }
      fs.writeFileSync(path.join(dir, "config.js"), configBody, "utf8");
      const before = fs.readFileSync(path.join(dir, "staticwebapp.config.json"), "utf8");
      execFileSync("python3", [
        path.join(ROOT, "tools", "analytics_csp.py"), "--root", dir, "--write", ...extra,
      ], { stdio: "pipe" });
      return {
        before,
        after: fs.readFileSync(path.join(dir, "staticwebapp.config.json"), "utf8"),
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const cspOf = (text) => JSON.parse(text).globalHeaders["Content-Security-Policy"];
  const connectOf = (csp) => csp.split(";").map((d) => d.trim())
    .find((d) => d.startsWith("connect-src"));

  test("with no site id the deployed config is byte-identical to the committed one", () => {
    const committed = read("staticwebapp.config.json");
    const result = applyTo(configWith("plausible", ""));
    // Byte-identical, not merely equal-as-JSON: a reflow would be a change this
    // work has no business making to a file another team owns.
    expect(result.after).toBe(result.before);
    expect(result.after).toBe(committed);
  });

  test("with a site id exactly one connect-src origin is added and script-src is untouched", () => {
    const result = applyTo(configWith("plausible", TEST_SITE));
    const before = cspOf(result.before);
    const after = cspOf(result.after);

    expect(after).toContain("https://plausible.io");
    // One directive gained exactly one token; nothing else moved.
    const beforeDirs = before.split(";").map((d) => d.trim()).filter(Boolean);
    const afterDirs = after.split(";").map((d) => d.trim()).filter(Boolean);
    expect(afterDirs).toHaveLength(beforeDirs.length);
    const changed = afterDirs.filter((d, i) => d !== beforeDirs[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toBe(connectOf(before) + " https://plausible.io");

    // script-src — the directive a vendor tag would have widened — is identical,
    // inline hashes included.
    expect(afterDirs.find((d) => d.startsWith("script-src")))
      .toBe(beforeDirs.find((d) => d.startsWith("script-src")));

    // The grant is one exact origin. The pre-existing
    // `https://*.azurewebsites.net` stays, so the check is that the wildcard
    // COUNT did not grow — not that no wildcard exists.
    const wildcards = (text) => (text.match(/\*/g) || []).length;
    expect(wildcards(after)).toBe(wildcards(before));
    expect(connectOf(after)).not.toContain("plausible.io/api");
    expect(connectOf(after)).not.toContain("https://*.plausible.io");
    expect(connectOf(after)).not.toContain("*plausible*");
    expect(connectOf(after)).not.toMatch(/\bhttps:\s|connect-src\s+\*/);
  });

  test("the provider line alone selects the origin", () => {
    const plausible = cspOf(applyTo(configWith("plausible", TEST_SITE)).after);
    const fathom = cspOf(applyTo(configWith("fathom", TEST_SITE)).after);
    expect(plausible).toContain("https://plausible.io");
    expect(plausible).not.toContain("usefathom.com");
    expect(fathom).toContain("https://cdn.usefathom.com");
    expect(fathom).not.toContain("plausible.io");
  });

  test("re-running the tool is idempotent rather than adding the origin twice", () => {
    const dir = scratch();
    try {
      fs.copyFileSync(path.join(ROOT, "staticwebapp.config.json"),
        path.join(dir, "staticwebapp.config.json"));
      fs.writeFileSync(path.join(dir, "config.js"), configWith("plausible", TEST_SITE), "utf8");
      const args = [path.join(ROOT, "tools", "analytics_csp.py"), "--root", dir, "--write"];
      execFileSync("python3", args, { stdio: "pipe" });
      const once = fs.readFileSync(path.join(dir, "staticwebapp.config.json"), "utf8");
      execFileSync("python3", args, { stdio: "pipe" });
      const twice = fs.readFileSync(path.join(dir, "staticwebapp.config.json"), "utf8");
      expect(twice).toBe(once);
      expect((once.match(/https:\/\/plausible\.io/g) || [])).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a site id with an unknown provider refuses instead of shipping a blocked beacon", () => {
    const dir = scratch();
    try {
      fs.copyFileSync(path.join(ROOT, "staticwebapp.config.json"),
        path.join(dir, "staticwebapp.config.json"));
      fs.writeFileSync(path.join(dir, "config.js"), configWith("gtag", TEST_SITE), "utf8");
      let failed = null;
      try {
        execFileSync("python3",
          [path.join(ROOT, "tools", "analytics_csp.py"), "--root", dir, "--write"],
          { stdio: "pipe" });
      } catch (error) {
        failed = error;
      }
      expect(failed, "an unknown provider was accepted").not.toBeNull();
      expect(failed.status).not.toBe(0);
      // And it changed nothing on the way out.
      expect(fs.readFileSync(path.join(dir, "staticwebapp.config.json"), "utf8"))
        .toBe(read("staticwebapp.config.json"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe("analytics wiring (static)", () => {
  const html = read("index.html");

  test("index.html loads config.js, then the banner, then the hook", () => {
    expect(html, "index.html does not load analytics.js")
      .toContain('<script src="analytics.js" defer></script>');
    expect(html, "index.html does not load the consent banner")
      .toContain('<script src="consent.js" defer></script>');

    const configAt = html.indexOf('src="config.js"');
    const consentAt = html.indexOf('src="consent.js"');
    const analyticsAt = html.indexOf('src="analytics.js"');
    expect(configAt, "config.js is missing").toBeGreaterThan(-1);
    // config.js must be set before either reader runs, and both readers are
    // `defer`, so they execute in document order: the banner's seam exists
    // before the hook asks for it.
    expect(configAt, "config.js must precede consent.js").toBeLessThan(consentAt);
    expect(consentAt, "consent.js must precede analytics.js").toBeLessThan(analyticsAt);
    expect((html.match(/analytics\.js/g) || []))
      .toHaveLength(1);
    expect((html.match(/consent\.js/g) || []))
      .toHaveLength(1);
  });

  test("the page carries a cookie-settings control so the answer can change", () => {
    expect(html).toContain("data-consent-open");
    expect(html).toContain('<link rel="stylesheet" href="consent.css">');
  });

  test("consent.js exists and is served, so the seam is real and not just referenced", async ({ page }) => {
    // The wiring test above reads index.html, and a tag pointing at a missing
    // file still reads as wired. This loads the page and requires the script to
    // have actually produced a banner and a live seam, which is the difference
    // between "the page references the banner" and "the page has one".
    await serveOffline(page);
    const served = [];
    page.on("response", (response) => {
      if (response.url().endsWith("/consent.js")) served.push(response.status());
    });
    await page.goto("/");
    await page.waitForLoadState("load");

    expect(served, "consent.js was never fetched").not.toEqual([]);
    expect(served.every((status) => status === 200), `consent.js served ${served}`).toBe(true);
    await expect(page.locator("[data-consent]")).toBeVisible();
    expect(await page.evaluate(() => typeof (window.WantNotConsent || {}).onChange))
      .toBe("function");
  });

  test("the hook ships no vendor payload and creates no script tag", () => {
    const js = read("analytics.js");
    // No vendor SDK and no DOM script injection: the beacon is the whole hook.
    expect(js).not.toMatch(/createElement\(\s*['"]script['"]\s*\)/);
    expect(js).not.toMatch(/googletagmanager|google-analytics|gtag\(|mixpanel|segment\.io/);
  });

  test("the banner's provider table and the hook's cannot drift apart", () => {
    // The banner decides whether to claim measurement, and the hook decides
    // whether to send. Two tables answering the same question is exactly the
    // drift that ships copy contradicting behaviour, so they are compared.
    const hookBlock = read("analytics.js").match(/var PROVIDERS = \{([\s\S]*?)\n  \};/);
    const bannerBlock = read("consent.js").match(/var PROVIDER_LABELS = \{([\s\S]*?)\n  \};/);
    expect(hookBlock, "PROVIDERS not found in analytics.js").not.toBeNull();
    expect(bannerBlock, "PROVIDER_LABELS not found in consent.js").not.toBeNull();
    // Only the table's own entries: four-space indent is the provider level in
    // both files, and the hook's nested `endpoint`/`payload` keys sit deeper.
    const keys = (block) => [...block[1].matchAll(/^ {4}([a-z][a-z0-9_-]*):/gm)]
      .map((m) => m[1]).sort();
    expect(keys(bannerBlock), "the banner table is empty or misread").toHaveLength(2);
    expect(keys(bannerBlock)).toEqual(keys(hookBlock));
  });

  test("the two candidate endpoints, and nothing else, are hard-coded", () => {
    const js = read("analytics.js");
    const urls = js.match(/https:\/\/[a-z0-9.\-]+/gi) || [];
    expect(new Set(urls)).toEqual(new Set([
      "https://plausible.io",
      "https://cdn.usefathom.com",
    ]));
  });
});
