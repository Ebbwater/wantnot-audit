// Analytics hook — one provider-neutral pageview beacon.
//
// Ported from `dashboard/analytics.js` in ebbwater/wantnot (GTM W3, commit
// 38178b3) because the live audit page is served from *this* repository, not
// from the marketing site. The contract is unchanged; only the paths in this
// header and in docs/ANALYTICS.md differ. See docs/ANALYTICS.md for the launch
// step, the CSP mechanism and the consent surface this page carries.
//
// Owner decision 2026-11-11: no provider is chosen, so this ships with no
// vendor code and no traffic. The site id in `config.js` is empty, and an empty
// site id means nothing here runs. Launch is a config edit.
//
// WHY A BEACON AND NOT A VENDOR TAG. The two candidates use different tag
// attributes (`data-domain` vs `data-site`) and each needs its own CDN fetch
// under script-src, so shipping "the hook" as a vendor tag ships one vendor's
// payload before the owner has chosen that vendor. A POST carries the same
// pageview with no third-party code in the page, and the launch step then
// widens connect-src by one origin and leaves script-src — and its inline
// hashes — untouched. The PROVIDERS table is data; choosing one is one line.
//
// CONFIG — the deploy-time mechanism config.js already uses for
// WANTNOT_API_BASE and WANTNOT_AUDIT_CLIENT_ID:
//
//   window.WANTNOT_ANALYTICS = { provider: 'plausible', site: '<id>' };
//
// Both empty is the shipped state. Inert means inert: no request, no vendor
// global, and the page's own DOM untouched.
//
// FOUR INDEPENDENT REASONS THIS STAYS SILENT, each fail-closed:
//   1. no site id            — the shipped state;
//   2. unknown provider      — a typo must not fall through to a guess;
//   3. consent not 'accept'  — `window.WantNotConsent` (consent.js) is the
//                              documented seam: non-essential code must do
//                              nothing unless the answer is accept;
//   4. no consent seam       — a page that never asked cannot claim an answer,
//                              so a page with no banner sends nothing.
//
// The reported URL is origin + pathname: query and fragment are dropped
// deliberately, because the audit page accepts `?tenant=` and a beacon must not
// turn a visitor's query string into a third party's log line.
//
// `window.WantNotAnalytics` is the observable seam. `state` names why nothing
// was sent, because a configured hook that is silent looks identical to a
// broken one. When a beacon leaves, the root element carries
// `data-analytics="<provider>"` so activation is visible without a network
// capture.

(function () {
  'use strict';

  // CANDIDATE providers. Neither is chosen, and neither endpoint is verified
  // against the vendor's current API here — before a site id is set, confirm
  // `endpoint` and `payload` against that provider's documentation. The switch
  // itself stays one line in config.js.
  var PROVIDERS = {
    plausible: {
      endpoint: 'https://plausible.io/api/event',
      payload: function (site, path) { return { n: 'pageview', u: path, d: site }; }
    },
    fathom: {
      endpoint: 'https://cdn.usefathom.com/track',
      payload: function (site, path) { return { h: site, p: path }; }
    }
  };

  var config = window.WANTNOT_ANALYTICS || {};
  var provider = typeof config.provider === 'string' ? config.provider.trim() : '';
  var site = typeof config.site === 'string' ? config.site.trim() : '';
  var entry = Object.prototype.hasOwnProperty.call(PROVIDERS, provider)
    ? PROVIDERS[provider]
    : null;
  // Read once, up front: the getters must answer before the tail runs.
  var consent = window.WantNotConsent;
  var sent = false;
  var failed = false;

  function markTracked() {
    document.documentElement.setAttribute('data-analytics', provider);
  }

  function send() {
    if (sent || !entry || !site) return false;
    sent = true;
    var url = entry.endpoint;
    var body = JSON.stringify(entry.payload(site, location.origin + location.pathname));
    try {
      if (typeof fetch === 'function') {
        // keepalive so a pageview fired on the way out is not cancelled by the
        // navigation it describes. credentials omit: no cookie, ever.
        fetch(url, {
          method: 'POST',
          body: body,
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          credentials: 'omit',
          referrerPolicy: 'no-referrer'
        }).then(function (response) {
          // Marked only once the request actually went, so a blocked or broken
          // endpoint cannot advertise itself as a delivered pageview.
          if (response && response.ok === false) {
            failed = true;
            return;
          }
          markTracked();
        }).catch(function () {
          // A failed beacon is not the page's problem, but it is reported
          // through `state` so a broken endpoint cannot look like a delivery.
          failed = true;
        });
      } else if (navigator && typeof navigator.sendBeacon === 'function'
                 && typeof Blob === 'function') {
        if (!navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) {
          failed = true;
          sent = false;
          return false;
        }
        markTracked();
      } else {
        failed = true;
        sent = false;
        return false;
      }
    } catch (err) {
      failed = true;
      sent = false;
      return false;
    }
    return true;
  }

  window.WantNotAnalytics = {
    get enabled() { return !!(entry && site); },
    get provider() { return entry ? provider : ''; },
    // 'inert' (no provider/site: the shipped state) | 'awaiting-consent'
    // (configured, banner present, answer is not accept) | 'no-consent-seam'
    // (configured on a page with no banner: a wiring mistake to fix) |
    // 'send-failed' (attempted and did not go: a broken endpoint or config) |
    // 'sent'. A configured hook that is silent must say why, or it is
    // indistinguishable from a working one.
    get state() {
      if (!entry || !site) return 'inert';
      if (failed) return 'send-failed';
      if (sent) return 'sent';
      return consent && typeof consent.onChange === 'function'
        ? 'awaiting-consent'
        : 'no-consent-seam';
    },
    send: send
  };

  if (!entry || !site) return; // 1 + 2: inert. No tag, no beacon, no request.

  if (consent && consent.state === 'accept') {
    send();
  } else if (consent && typeof consent.onChange === 'function') {
    // 3 + 4: wait for an answer and only ever act on 'accept'. A page with no
    // banner has no seam to ask, so it stays silent and `state` says why.
    consent.onChange(function (state) {
      if (state === 'accept') send();
    });
  }
})();
