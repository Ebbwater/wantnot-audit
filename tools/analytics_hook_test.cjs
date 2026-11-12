/* Analytics hook — offline regressions for analytics.js.
 *
 * No browser and no network: the real hook file runs in a vm context with a
 * synthetic window/document/location, and `fetch` is a recording stub. That is
 * the same contract e2e/analytics.spec.js proves in a real browser, reduced to
 * what this gate can run without Playwright browsers installed — so the
 * inertness guarantee is held on every push, not only in the browser job.
 *
 * REGRESSION names mark the properties that must not return.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'analytics.js'), 'utf8');

// Run the hook against a controlled page. `fetch` and `sendBeacon` record
// instead of sending, so a passing assertion is evidence about the code, not
// about the wire.
function run({ config, consent, hasConsentSeam = true, url = 'https://audit.wantnot.ebbwater.net/' }) {
  const calls = { fetch: [], beacon: [], scripts: [] };
  const attrs = {};
  const listeners = [];

  const document = {
    documentElement: {
      setAttribute: (name, value) => { attrs[name] = value; },
      getAttribute: (name) => attrs[name] ?? null,
    },
    createElement: (tag) => { calls.scripts.push(tag); return {}; },
  };
  const location = new URL(url);

  const window = { WANTNOT_ANALYTICS: config, document, location };
  if (consent !== undefined) {
    window.WantNotConsent = {
      get state() { return consent; },
      onChange: hasConsentSeam
        ? (fn) => { listeners.push(fn); return () => {}; }
        : undefined,
    };
  }

  const context = {
    window,
    document,
    location,
    navigator: {
      sendBeacon: (target, body) => { calls.beacon.push({ target, body }); return true; },
    },
    Blob: class { constructor(parts) { this.parts = parts; } },
    fetch: (target, init) => {
      calls.fetch.push({ target, init });
      return Promise.resolve({ ok: true });
    },
    Object, JSON, console,
  };
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context);

  return {
    calls,
    attrs,
    listeners,
    seam: window.WantNotAnalytics,
    // The hook marks the page only after the POST resolves, so an assertion on
    // `data-analytics` must let the microtask queue drain first.
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
    // Simulate the visitor answering the banner later.
    answer: (state) => listeners.forEach((fn) => fn(state)),
  };
}

const EMPTY = { provider: '', site: '' };
const CONFIGURED = (provider = 'plausible', site = 'test-site-id') => ({ provider, site });

const cases = [];
const check = (name, fn) => cases.push([name, fn]);

// ── the shipped config ──────────────────────────────────────────────────────

check('REGRESSION the committed config.js ships an empty analytics site id', () => {
  // The browser suite asserts this too, but the gate runs with --no-browser on
  // a machine with no Playwright binary. Without this case, "someone committed
  // a real site id" would pass the offline gate untouched.
  const config = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
  assert.ok(config.includes('window.WANTNOT_ANALYTICS'),
    'config.js has no WANTNOT_ANALYTICS block');
  assert.ok(config.includes("window.WANTNOT_ANALYTICS = { provider: '', site: '' };"),
    'config.js ships a configured analytics site, which must never be the default');
});

// ── the shipped state ────────────────────────────────────────────────────────

check('REGRESSION an empty site id sends no beacon and creates no script tag', () => {
  for (const consent of [undefined, 'unset', 'accept', 'reject']) {
    const r = run({ config: EMPTY, consent });
    assert.deepEqual(r.calls.fetch, [], `fetch fired with consent=${consent}`);
    assert.deepEqual(r.calls.beacon, [], `sendBeacon fired with consent=${consent}`);
    assert.deepEqual(r.calls.scripts, [], `a script tag was created with consent=${consent}`);
    assert.equal(r.attrs['data-analytics'], undefined);
    assert.equal(r.seam.enabled, false);
    assert.equal(r.seam.state, 'inert');
  }
});

check('REGRESSION an absent WANTNOT_ANALYTICS object is inert', () => {
  const r = run({ config: undefined, consent: 'accept' });
  assert.deepEqual(r.calls.fetch, []);
  assert.equal(r.seam.enabled, false);
  assert.equal(r.seam.state, 'inert');
});

check('REGRESSION whitespace-only config values are inert, not "configured"', () => {
  for (const config of [{ provider: 'plausible', site: '   ' },
                        { provider: '  ', site: 'test-site-id' },
                        { provider: 'plausible' },
                        { site: 'test-site-id' }]) {
    const r = run({ config, consent: 'accept' });
    assert.deepEqual(r.calls.fetch, [], JSON.stringify(config));
    assert.equal(r.seam.enabled, false);
  }
});

// ── consent ─────────────────────────────────────────────────────────────────

check('REGRESSION a configured hook sends nothing until consent is accept', () => {
  for (const consent of [undefined, 'unset', 'reject']) {
    const r = run({ config: CONFIGURED(), consent });
    assert.deepEqual(r.calls.fetch, [], `fetch fired with consent=${consent}`);
    assert.equal(r.attrs['data-analytics'], undefined);
  }
});

check('REGRESSION accept sends exactly one beacon, and only once', async () => {
  const r = run({ config: CONFIGURED(), consent: 'accept' });
  assert.equal(r.calls.fetch.length, 1);
  assert.equal(r.calls.beacon.length, 0, 'fetch and sendBeacon must not both fire');
  const { target, init } = r.calls.fetch[0];
  assert.equal(target, 'https://plausible.io/api/event');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'omit', 'a beacon must never carry a cookie');
  assert.equal(init.keepalive, true);
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(r.seam.state, 'sent');
  await r.settle();
  assert.equal(r.attrs['data-analytics'], 'plausible');
  // Idempotent: a second call is a no-op.
  assert.equal(r.seam.send(), false);
  assert.equal(r.calls.fetch.length, 1);
});

check('REGRESSION answering the banner accept later sends one beacon', async () => {
  const r = run({ config: CONFIGURED(), consent: 'unset' });
  assert.deepEqual(r.calls.fetch, []);
  assert.equal(r.seam.state, 'awaiting-consent');
  r.answer('accept');
  assert.equal(r.calls.fetch.length, 1);
  assert.equal(r.seam.state, 'sent');
  await r.settle();
  assert.equal(r.attrs['data-analytics'], 'plausible');
  // A later change cannot replay it.
  r.answer('accept');
  assert.equal(r.calls.fetch.length, 1);
});

check('REGRESSION answering reject never sends', () => {
  const r = run({ config: CONFIGURED(), consent: 'unset' });
  r.answer('reject');
  assert.deepEqual(r.calls.fetch, []);
  assert.equal(r.attrs['data-analytics'], undefined);
});

check('REGRESSION a configured hook on a page with no consent seam reports it and stays silent', () => {
  // ✓·`state === 'no-consent-seam'` is the signal the audit-page card names:
  // a beacon wired to a page that never asks can never fire, and must say so.
  const r = run({ config: CONFIGURED(), consent: undefined });
  assert.deepEqual(r.calls.fetch, []);
  assert.equal(r.seam.state, 'no-consent-seam');
});

check('REGRESSION a seam without onChange is not an answered banner', () => {
  // A stub that exposes `state` but cannot notify is exactly the shape that
  // silently swallows a later Accept. It must report the missing seam.
  const r = run({ config: CONFIGURED(), consent: 'unset', hasConsentSeam: false });
  assert.deepEqual(r.calls.fetch, []);
  assert.equal(r.seam.state, 'no-consent-seam');
});

// ── provider selection ──────────────────────────────────────────────────────

check('REGRESSION an unknown provider is silent rather than guessed', () => {
  for (const provider of ['not-a-provider', 'PLAUSIBLE', 'gtag', 'plausible.io', '']) {
    const r = run({ config: CONFIGURED(provider), consent: 'accept' });
    assert.deepEqual(r.calls.fetch, [], `provider ${JSON.stringify(provider)} produced a request`);
    assert.equal(r.seam.enabled, false);
    assert.equal(r.seam.provider, '');
  }
});

check('surrounding whitespace is trimmed, not a distinct provider', () => {
  // Trimming is safe in the only direction that matters: it can normalise
  // 'plausible ' to a known provider, never to a different one.
  const r = run({ config: CONFIGURED(' plausible ', ' test-site-id '), consent: 'accept' });
  assert.equal(r.seam.provider, 'plausible');
  assert.equal(r.calls.fetch.length, 1);
  assert.equal(JSON.parse(r.calls.fetch[0].init.body).d, 'test-site-id');
});

check('the provider line alone selects the endpoint — no vendor SDK', () => {
  const plausible = run({ config: CONFIGURED('plausible'), consent: 'accept' });
  const fathom = run({ config: CONFIGURED('fathom'), consent: 'accept' });
  assert.equal(plausible.calls.fetch[0].target, 'https://plausible.io/api/event');
  assert.equal(fathom.calls.fetch[0].target, 'https://cdn.usefathom.com/track');
  assert.equal(plausible.seam.provider, 'plausible');
  assert.equal(fathom.seam.provider, 'fathom');
  // Each body carries the site id under that provider's own field name.
  assert.deepEqual(JSON.parse(plausible.calls.fetch[0].init.body),
    { n: 'pageview', u: 'https://audit.wantnot.ebbwater.net/', d: 'test-site-id' });
  assert.deepEqual(JSON.parse(fathom.calls.fetch[0].init.body),
    { h: 'test-site-id', p: 'https://audit.wantnot.ebbwater.net/' });
});

// ── what gets reported ──────────────────────────────────────────────────────

check('REGRESSION the beacon reports no query string or fragment', () => {
  // The audit page accepts ?tenant=<guid>. A beacon that carried it would put
  // a customer's directory id in a third party's log.
  const r = run({
    config: CONFIGURED(), consent: 'accept',
    url: 'https://audit.wantnot.ebbwater.net/?tenant=00000000-1111-2222-3333-444444444444#findings',
  });
  const body = JSON.parse(r.calls.fetch[0].init.body);
  const reported = body.u || body.p;
  assert.equal(reported, 'https://audit.wantnot.ebbwater.net/');
  assert.ok(!JSON.stringify(body).includes('tenant='), 'a tenant id leaked into the beacon');
});

// ── degradation ─────────────────────────────────────────────────────────────

check('a throwing fetch does not break the page and reports the failure', () => {
  const calls = [];
  const errors = [];
  const context = {
    window: {
      WANTNOT_ANALYTICS: CONFIGURED(),
      document: {
        documentElement: {
          setAttribute: () => { errors.push('attr'); },
          getAttribute: () => null,
        },
        createElement: () => { throw new Error('must not create an element'); },
      },
      location: new URL('https://audit.wantnot.ebbwater.net/'),
      WantNotConsent: { state: 'accept', onChange: () => {} },
    },
    navigator: { sendBeacon: () => { throw new Error('must not be reached'); } },
    Blob: class {},
    fetch: () => { calls.push(1); throw new Error('network exploded synchronously'); },
    Object, JSON, console,
  };
  context.document = context.window.document;
  context.location = context.window.location;
  context.globalThis = context;
  assert.doesNotThrow(() => vm.runInNewContext(SOURCE, context));
  assert.equal(calls.length, 1);
  // A failed send must not look delivered, and must not look like the visitor
  // never answered either: those are different faults with different fixes.
  assert.equal(context.window.WantNotAnalytics.state, 'send-failed');
  assert.deepEqual(errors, [], 'a failed send must not mark the page as tracked');
});

check('a rejected sendBeacon marks the run as failed rather than sent', () => {
  const context = {
    window: {
      WANTNOT_ANALYTICS: CONFIGURED(),
      document: {
        documentElement: { setAttribute: () => {}, getAttribute: () => null },
        createElement: () => { throw new Error('must not create an element'); },
      },
      location: new URL('https://audit.wantnot.ebbwater.net/'),
      WantNotConsent: { state: 'accept', onChange: () => {} },
    },
    // No fetch: falls through to the beacon path, which refuses.
    navigator: { sendBeacon: () => false },
    Blob: class {},
    Object, JSON, console,
  };
  context.document = context.window.document;
  context.location = context.window.location;
  context.globalThis = context;
  assert.doesNotThrow(() => vm.runInNewContext(SOURCE, context));
  assert.equal(context.window.WantNotAnalytics.send(), false);
  assert.equal(context.window.WantNotAnalytics.state, 'send-failed');
});

check('a non-ok response is reported as failed, and never marks the page tracked', async () => {
  const attrs = {};
  const context = {
    window: {
      WANTNOT_ANALYTICS: CONFIGURED(),
      document: {
        documentElement: {
          setAttribute: (name, value) => { attrs[name] = value; },
          getAttribute: () => null,
        },
      },
      location: new URL('https://audit.wantnot.ebbwater.net/'),
      WantNotConsent: { state: 'accept', onChange: () => {} },
    },
    fetch: () => Promise.resolve({ ok: false }),
    Object, JSON, console,
  };
  context.document = context.window.document;
  context.location = context.window.location;
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.window.WantNotAnalytics.state, 'send-failed');
  assert.deepEqual(attrs, {});
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}\n${error.message}`);
    }
  }
  if (failed) {
    console.error(`\n${failed} of ${cases.length} analytics hook regressions failed`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS every analytics hook regression holds (${cases.length} cases)`);
  }
})();
