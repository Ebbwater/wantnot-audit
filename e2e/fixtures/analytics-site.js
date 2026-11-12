// Deploy-checkout fixture for e2e/analytics.spec.js.
//
// WHY THIS EXISTS. `connect-src` is a header on the *document* response, not
// something a page can grant itself. The obvious way to configure analytics in
// a test — `page.route("**/config.js", …)` to serve a config.js with a test
// site id — therefore cannot prove the beacon works on the launch path: the
// served document still carries the committed (inert) CSP, the browser refuses
// the POST, and the assertion is green only on the local static server, which
// sends no CSP at all. The WantNot repo found this on PR #539's hosted CI:
// three "configured" cases failed on the preview and passed locally, i.e. the
// configured half proved nothing about production.
//
// So the configured cases run against what production actually serves: a copy
// of this checkout with the deploy-time `config.js` written the way
// `.github/workflows/deploy.yml` writes it, `tools/analytics_csp.py --write`
// applied to that copy exactly as the deploy job applies it, and a small server
// that emits the resulting `staticwebapp.config.json`'s `globalHeaders` as
// response headers — the way Azure Static Web Apps applies them to every
// response.
//
// `withoutOrigin()` is the negative control: it strips the grant the tool
// added, and throws if the grant was not there to strip, so a control that
// silently changed nothing cannot pass as evidence.

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const CSP_TOOL = path.join(ROOT, "tools", "analytics_csp.py");
const PYTHON = process.env.AUDIT_TEST_PYTHON || "python3";

// Copied into the deploy checkout. Everything the page itself requests, plus
// the config the header comes from. `tools/`, `e2e/` and `node_modules/` are
// deliberately absent: the deploy upload does not serve them either.
const SERVED = [
  "index.html",
  "analytics.js",
  "consent.js",
  "consent.css",
  "audit_logic.js",
  "catalog.js",
  "kinds.js",
  "palette.css",
  "sort.js",
  "site.webmanifest",
  "robots.txt",
  "sitemap.xml",
  "skus.json",
  "staticwebapp.config.json",
  "brand",
  "fixtures",
];

// The deploy-time config.js, written the way the workflow's generator writes
// it. The site id is obviously synthetic — no real account exists — and the
// spec redirects the provider origin into a local fake, so nothing leaves the
// machine.
function configJsFor(provider, site) {
  return (
    "/* Generated at deploy — do not commit. */\n"
    + "window.WANTNOT_AUDIT_CLIENT_ID = 'audit-test-client-id';\n"
    + "window.WANTNOT_API_BASE = 'https://func-wantnot-4dc52f.azurewebsites.net';\n"
    + `window.WANTNOT_ANALYTICS = { provider: '${provider}', site: '${site}' };\n`
  );
}

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml; charset=utf-8",
};

// Build a deploy checkout: the served files, the generated config.js, and the
// `staticwebapp.config.json` the deploy job's CSP step produces from it.
//
// Returns { root, config, csp, committedCsp, refused, cleanup }. With no
// provider the checkout is inert and `csp` must equal the committed header.
//
// A config the tool REFUSES (a site id with an unknown provider) is reported as
// `refused: true` with the committed config left in place, because that is the
// deploy job's real outcome: the validate step exits non-zero and nothing is
// published. A caller asserting that case is asserting the refusal, not a
// served grant.
function buildCheckout({ provider = null, site = null } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wantnot-audit-deploy-"));
  const cleanup = () => fs.rmSync(scratch, { recursive: true, force: true });
  try {
    for (const name of SERVED) {
      const from = path.join(ROOT, name);
      const to = path.join(scratch, name);
      if (!fs.existsSync(from)) continue;
      fs.cpSync(from, to, { recursive: true });
    }
    if (provider !== null) {
      fs.writeFileSync(path.join(scratch, "config.js"), configJsFor(provider, site), "utf8");
    } else {
      fs.copyFileSync(path.join(ROOT, "config.js"), path.join(scratch, "config.js"));
    }
    // Exactly what the deploy job does, in the same order: validate, then
    // apply, then verify what will be deployed. A refusal is the job failing
    // before publication, so record it rather than serving a checkout
    // production would never have.
    let refused = false;
    try {
      execFileSync(PYTHON, [CSP_TOOL, "--root", scratch], { stdio: "pipe" });
      execFileSync(PYTHON, [CSP_TOOL, "--root", scratch, "--write"], { stdio: "pipe" });
      execFileSync(PYTHON, [CSP_TOOL, "--root", scratch, "--verify"], { stdio: "pipe" });
    } catch (error) {
      refused = true;
    }

    const config = JSON.parse(
      fs.readFileSync(path.join(scratch, "staticwebapp.config.json"), "utf8"),
    );
    const committedCsp = JSON.parse(
      fs.readFileSync(path.join(ROOT, "staticwebapp.config.json"), "utf8"),
    ).globalHeaders["Content-Security-Policy"];
    return {
      root: scratch,
      config,
      csp: config.globalHeaders["Content-Security-Policy"],
      committedCsp,
      refused,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// Serve a checkout with the headers SWA applies globally. The document
// response is the one that matters here, but globalHeaders reach every
// response on the real host, so reproduce that.
//
// `omitCsp` exists for one purpose: to reproduce the harness this suite
// replaced. A plain static file server (`python3 -m http.server`) sends no
// `Content-Security-Policy` at all, so a configured beacon that production
// blocks still succeeds there. Serving the identical bytes without the header
// is how the suite demonstrates that blindness instead of asserting it.
function startServer(root, config, csp) {
  const headers = { ...(config.globalHeaders || {}) };
  if (csp === null) {
    delete headers["Content-Security-Policy"];
  } else {
    headers["Content-Security-Policy"] = csp;
  }
  if (!headers["Content-Security-Policy"] && csp !== null) {
    throw new Error("fixture would serve no CSP; the whole point is the header");
  }
  const resolvedRoot = path.resolve(root);

  const server = http.createServer((request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://fixture.invalid").pathname);
    } catch (err) {
      pathname = "/";
    }
    let target = path.resolve(resolvedRoot, "." + pathname);
    if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
      response.writeHead(403, headers);
      response.end("forbidden");
      return;
    }
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      target = path.join(target, "index.html");
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404, headers);
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      ...headers,
      "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
    });
    response.end(fs.readFileSync(target));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// Build a deploy checkout and serve it under the CSP the deploy step derived.
//
// `cspTransform` receives that CSP and returns the CSP to serve, so a negative
// control can remove a grant without editing the checkout. `serveNoCsp` serves
// the same bytes with no CSP header at all — the plain-static-server harness.
async function deploySite(options = {}) {
  const built = buildCheckout(options);
  let csp = options.cspTransform ? options.cspTransform(built.csp) : built.csp;
  if (options.serveNoCsp) csp = null;
  try {
    const served = await startServer(built.root, built.config, csp);
    return {
      origin: served.origin,
      csp,
      derivedCsp: built.csp,
      committedCsp: built.committedCsp,
      refused: built.refused,
      config: built.config,
      close: async () => {
        await served.close();
        built.cleanup();
      },
    };
  } catch (error) {
    built.cleanup();
    throw error;
  }
}

// The negative control: remove an origin the deploy step granted. Refuses to
// return a CSP that was already missing it, because a control that stripped
// nothing would "prove" the beacon is blocked by a header it never changed.
function withoutOrigin(csp, origin) {
  const directives = csp.split(";").map((part) => part.trim());
  const connect = directives.find((part) => part.startsWith("connect-src"));
  if (!connect) throw new Error("CSP has no connect-src to strip the grant from");
  if (!connect.split(" ").includes(origin)) {
    throw new Error(`derived CSP does not grant ${origin}; control would be vacuous`);
  }
  return directives
    .map((part) => {
      if (!part.startsWith("connect-src")) return part;
      return part.split(" ").filter((token) => token !== origin).join(" ");
    })
    .join("; ");
}

module.exports = {
  ROOT,
  buildCheckout,
  configJsFor,
  deploySite,
  withoutOrigin,
};
