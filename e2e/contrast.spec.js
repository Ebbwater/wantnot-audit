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
  // Settle the paint before axe samples. axe's color-contrast rule reads
  // rendered pixel colours, and under a dark `prefers-color-scheme` the token
  // block flips after first paint: a sample taken mid-repaint reports blends
  // (observed once in ~10 combined runs: `.lede` as #434850 on #0c0f14, values
  // that exist nowhere in the source and sit between the light and dark token
  // sets). Two animation frames plus a forced style/layout flush pins the
  // measurement to the settled theme. This does not weaken the assertion —
  // it still runs the same axe rule over the same DOM with the same thresholds;
  // it only stops a transient paint state from being measured as if it were a
  // colour choice.
  await page.evaluate(() => new Promise((done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // Flush style + layout so the next paint is the settled one.
      void document.body.offsetHeight;
      done();
    }));
  }));
  await page.addScriptTag({ content: axeSource });
  const results = await page.evaluate(async () => {
    const results = await window.axe.run(document, { runOnly: ["color-contrast"] });
    return results.violations.flatMap((violation) => violation.nodes.map((node) => ({
      target: node.target,
      html: node.html.slice(0, 180),
      failureSummary: node.failureSummary,
    })));
  });
  expect(results, `${state}:\n${JSON.stringify(results, null, 2)}`).toEqual([]);

  // The cookie banner is the one `position: fixed` overlay on this page, and
  // axe returns its text as `incomplete` ("1:1 contrast ratio") because it
  // cannot sample the backdrop beneath a fixed layer over a scrolling document.
  // Reading only `violations` would report a pass for text axe never measured.
  // So the banner's own pairs are computed here, from the rendered colours, and
  // a pair below AA fails this gate — no axe involvement, no silent gap.
  const banner = await page.evaluate(() => {
    const region = document.querySelector("[data-consent]");
    if (!region || region.hidden) return null;

    const parse = (value) => {
      const m = String(value).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1].split(",").map((n) => parseFloat(n));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const lum = ({ r, g, b }) => {
      const ch = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const ratio = (a, b) => {
      const la = lum(a), lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };

    const sheet = region.querySelector(".sheet");
    const pageBg = parse(getComputedStyle(document.body).backgroundColor) ||
      parse(getComputedStyle(document.documentElement).backgroundColor);
    let sheetBg = parse(getComputedStyle(sheet).backgroundColor);
    if (sheetBg && sheetBg.a < 1) sheetBg = over(sheetBg, pageBg);

    const pairs = [];
    const sample = (label, nodes) => {
      nodes.forEach((node) => {
        if (!node || !node.textContent.trim()) return;
        const colour = parse(getComputedStyle(node).color);
        if (!colour) return;
        const fg = colour.a < 1 ? over(colour, sheetBg) : colour;
        const size = parseFloat(getComputedStyle(node).fontSize);
        const weight = parseInt(getComputedStyle(node).fontWeight, 10) || 400;
        // WCAG AA: 3:1 for large text (>=24px, or >=18.66px bold), else 4.5:1.
        const large = size >= 24 || (size >= 18.66 && weight >= 700);
        pairs.push({
          label,
          text: node.textContent.trim().slice(0, 40),
          ratio: Math.round(ratio(fg, sheetBg) * 100) / 100,
          required: large ? 3 : 4.5,
        });
      });
    };
    sample("body copy", [region.querySelector(".say")]);
    // The bold lead, the policy link and the two buttons carry their own
    // colours, so each is measured rather than assumed to inherit a passing one.
    sample("inline", [...region.querySelectorAll(".say b, .say a")]);
    sample("buttons", [...region.querySelectorAll(".acts button")]);
    return { pairs, sheetBg, pageBg };
  });

  if (banner) {
    expect(banner.pairs.length, `${state}: the banner produced no measurable text`).toBeGreaterThan(2);
    const failing = banner.pairs.filter((pair) => pair.ratio < pair.required);
    expect(failing, `${state}: cookie banner contrast below AA:\n${JSON.stringify(failing, null, 2)}`)
      .toEqual([]);
  }
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
