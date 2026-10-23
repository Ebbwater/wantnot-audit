const { test, expect } = require("@playwright/test");
const fs = require("fs");
const axeSource = fs.readFileSync(require.resolve("axe-core"), "utf8");

// Synthetic exports exercise the real file inputs, parser, analyzer and report.
// No customer data or credentials are used; the CSV never leaves the browser.
const USERS_CSV = [
  "User principal name,Display name,Sign-in blocked,Licenses,Last sign-in,Created",
  "disabled@example.test,Disabled Example,Yes,SPE_E3,2020-01-01,2020-01-01",
  "dormant@example.test,Dormant Example,No,SPE_E3,2020-01-01,2020-01-01",
  "never@example.test,Never Example,No,SPE_E3,,2020-01-01",
  `active@example.test,Active Example,No,SPE_E3,${new Date().toISOString()},2020-01-01`,
].join("\r\n");
const LICENSES_CSV = "License,Purchased,Assigned\r\nSPE_E3,7,4\r\n";

test.beforeEach(async ({ page }) => {
  // Auth is outside this contrast gate. Provide a configured, signed-out
  // boundary so local placeholder config and CDN availability cannot replace
  // the page under test with a setup/error screen. Rendering is never stubbed.
  await page.route("**/config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "window.WANTNOT_AUDIT_CLIENT_ID = 'contrast-test-client';",
  }));
  await page.route(/https:\/\/(alcdn\.msauth\.net|cdn\.jsdelivr\.net)\/.*msal-browser.*\.js/, (route) => route.fulfill({
    contentType: "application/javascript",
    body: "window.msal = { PublicClientApplication: class { async handleRedirectPromise() { return null; } getAllAccounts() { return []; } } };",
  }));
  // An import must not need any directory, sign-in or product API call.
  await page.route(/https:\/\/(graph\.microsoft\.com|login\.microsoftonline\.com|[^/]+\.azurewebsites\.net)\//, (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("#impGo")).toBeVisible();
});

async function expectContrast(page, state) {
  await page.evaluate(() => document.fonts.ready);
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    const results = await window.axe.run(document, { runOnly: ["color-contrast"] });
    return results.violations.flatMap((violation) => violation.nodes.map((node) => ({
      target: node.target,
      html: node.html.slice(0, 180),
      failureSummary: node.failureSummary,
    })));
  });
  expect(violations, `${state}:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
}

for (const scheme of ["light", "dark"]) {
  test.describe(`${scheme} theme contrast`, () => {
    test.use({ colorScheme: scheme });

    test("initial audit page has no color-contrast violations", async ({ page }) => {
      await expectContrast(page, `${scheme} initial audit`);
    });

    test("CSV report, expanded findings and selected legend have no color-contrast violations", async ({ page }) => {
      await page.locator("#impUsers").setInputFiles({
        name: "synthetic-users.csv", mimeType: "text/csv", buffer: Buffer.from(USERS_CSV),
      });
      await page.locator("#impLic").setInputFiles({
        name: "synthetic-licenses.csv", mimeType: "text/csv", buffer: Buffer.from(LICENSES_CSV),
      });
      await page.locator("#impGo").click();
      await expect(page.locator("#csv")).toBeVisible();
      await expect(page.locator("#fBody .grp-head")).toHaveCount(4);
      for (const row of await page.locator("#fBody .grp-head").all()) await row.click();
      await expect(page.locator("#fBody .grp-item:visible")).toHaveCount(4);
      await expect(page.locator("#fBody")).toContainText("Disabled accounts");
      await expect(page.locator("#fBody")).toContainText("Dormant users");
      await expect(page.locator("#fBody")).toContainText("Never signed in");
      // Dormant's heat-ramp fill must not be reused as a text colour when the
      // legend selects it. Keep the actual click/paint path in this check.
      const legend = page.locator('.legend-item[data-kind="dormant_user"]');
      await legend.click();
      await expect(legend).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".axis .detail")).toContainText("Dormant users");
      await expectContrast(page, `${scheme} imported report and selected legend`);
    });
  });
}

for (const [label, usersName, usersType, licensesName, licensesType] of [
  ['users extension', 'users.exe', 'text/csv', 'licenses.csv', 'text/csv'],
  ['users MIME', 'users.csv', 'application/pdf', 'licenses.csv', 'text/csv'],
  ['optional licenses', 'users.csv', 'text/csv', 'licenses.pdf', 'application/pdf'],
]) {
  test(`reject non-CSV ${label} before reading either file`, async ({ page }) => {
    await page.evaluate(() => {
      const Original = window.FileReader;
      window.fileReads = 0;
      window.FileReader = class extends Original {
        constructor() { super(); window.fileReads++; }
      };
    });
    await page.locator('#impUsers').setInputFiles({name:usersName,mimeType:usersType,buffer:Buffer.from(USERS_CSV)});
    await page.locator('#impLic').setInputFiles({name:licensesName,mimeType:licensesType,buffer:Buffer.from(LICENSES_CSV)});
    await page.locator('#impGo').click();
    expect(await page.evaluate(() => window.fileReads)).toBe(0);
    await expect(page.locator('#impErr')).toContainText('CSV');
    await expect(page.locator('#impGo')).toBeEnabled();
  });
}

test('CSV with uppercase extension and empty or plain-text MIME is accepted', async ({ page }) => {
  await page.locator('#impUsers').setInputFiles({name:'users.CSV',mimeType:'',buffer:Buffer.from(USERS_CSV)});
  await page.locator('#impLic').setInputFiles({name:'licenses.csv',mimeType:'text/plain',buffer:Buffer.from(LICENSES_CSV)});
  await page.locator('#impGo').click();
  await expect(page.locator('#again')).toBeVisible();
});
