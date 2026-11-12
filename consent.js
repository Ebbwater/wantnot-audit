// Cookie consent banner for the audit page — the seam analytics.js reads.
//
// Ported from `dashboard/consent.js` in ebbwater/wantnot (GTM W3, commit
// 38178b3). The audit page had no banner at all: it is one page whose whole
// promise is "nothing is stored", so nothing non-essential ever needed an
// answer. Wiring a beacon here without a seam would have shipped
// `state === 'no-consent-seam'` — a hook that can never fire and never says
// why — so the banner ships with the hook, and `window.WantNotConsent` is the
// same seam the nine marketing pages already expose.
//
// What it does:
//
//   * first visit: one region, Accept and Reject of equal weight, and a link
//     to the privacy policy. No pre-ticked box, no "manage preferences" maze,
//     no dismiss-without-answering;
//   * the answer is persisted under one namespaced key (`wantnot.consent`,
//     holding {state, at}); nothing else is written;
//   * the page's `[data-consent-open]` control reopens the banner, so the
//     answer can change at any time;
//   * `window.WantNotConsent = { state, onChange }` is the documented seam:
//     `state` is 'unset' | 'accept' | 'reject' read live from storage, and
//     `onChange(fn)` runs fn(state) on every later change, returning an
//     unsubscribe. analytics.js reads this and does nothing unless the answer
//     is 'accept'.
//
// THE COPY IS DERIVED FROM THE SAME CONFIG THE BEACON READS. The marketing
// banner hard-codes the sentence "No analytics, no advertising cookie, no
// tracking between sites", and docs/ANALYTICS-LAUNCH.md warns that the
// sentence becomes false the moment a provider is configured — a launch-time
// edit someone must remember to make. Here the sentence is selected from
// `window.WANTNOT_ANALYTICS.site`, so the banner cannot describe a different
// site from the one it is running on: inert ships the containment wording, a
// configured site id ships the measurement wording, and no launch step can
// leave the two disagreeing. Consent obtained under a false description is not
// consent, so the description is computed rather than remembered.
//
// What the copy claims is deliberately limited to what this page controls —
// what the beacon sends and what it does not touch. What a *provider* does
// with a request (retention, IP truncation, country) is a statement about the
// vendor's published terms, not about this code; the banner points at the
// privacy policy for it, and docs/ANALYTICS.md records that the policy wording
// must land in the same launch as the site id.
//
// English only, deliberately. The page is `lang="en"` and has no localized
// mirror; inventing translations here would ship copy no native speaker
// reviewed. `copy()` falls back to English for any other language, so a future
// mirror fails safe (readable, if untranslated) rather than shipping
// machine-invented wording under a language tag. A mirror adds its own key.
//
// A blocked or full localStorage (private mode, storage disabled) is not an
// error: the banner still works for the visit, the choice simply cannot be
// remembered, and asking again next visit is the safe failure. Never throw
// from an enhancement.
//
// Accessibility: a labelled region, never a modal. Focus is not trapped and
// Escape is not hijacked — there is no close button, because the only way past
// a consent banner is to answer it. Reopening from the page control moves focus
// to the actions so a keyboard reader lands where the buttons are; the first
// visit does not steal focus from the page. `position: fixed` keeps it out of
// flow, so it adds nothing to the audit form's layout.
//
// Treeshaken relative to the marketing original: no sticky-mobile-CTA
// interlock (that `[data-sticky-cta]` bar exists only on the marketing pages,
// so here it would be code watching for an element that can never appear), and
// no font-settle delay (the marketing banner needed it against that repo's CLS
// budget; this repo has no CLS gate, and adding a timer whose only effect is to
// hide a consent banner later is a worse trade than the shift it prevents).

(function () {
  'use strict';

  var STORAGE_KEY = 'wantnot.consent';
  // The audit page has no local policy page. This is the same target the
  // page's own unlock form already links for privacy.
  var POLICY_HREF = 'https://wantnot.ebbwater.net/privacy';

  // Provider labels for the configured copy, and — because this is the same
  // question analytics.js answers — the set of providers this page knows how to
  // send to. A provider outside this table ships no beacon (the hook refuses an
  // unknown provider rather than guessing), so the banner must not claim
  // measurement for it. `e2e/analytics.spec.js` asserts these keys equal
  // PROVIDERS in analytics.js, so the two lists cannot drift apart silently.
  var PROVIDER_LABELS = {
    plausible: 'Plausible',
    fathom: 'Fathom'
  };

  var COPY = {
    en: {
      label: 'Cookie settings',
      lead: 'Cookies.',
      // Inert: the shipped wording, and true of the shipped site.
      inert: 'This page uses only what it needs to work. No advertising cookie, no tracking between sites. See the',
      // Configured: names the measurement, and limits every claim to what this
      // page's own code does.
      measured: 'This page uses only what it needs to work, plus one anonymous page view so we can tell the audit is being found: the page address without its query string, sent as a plain request with no cookie and with nothing from your directory, your files or your Microsoft 365 account. See the',
      link: 'privacy policy',
      tail: '.',
      accept: 'Accept',
      reject: 'Reject'
    }
  };

  // Falls back to English: a language this file has no reviewed copy for gets
  // readable, correct-in-substance text rather than machine-invented wording
  // under that language tag.
  function copy() {
    var lang = (document.documentElement.getAttribute('lang') || 'en').toLowerCase();
    return COPY[lang] || COPY.en;
  }

  // The same "will a beacon actually leave this page" question analytics.js
  // answers: a non-empty site id AND a provider in this page's table. A site id
  // with an unknown provider sends nothing (the hook refuses to guess), so the
  // containment wording is the true one for that state — the banner must not
  // describe a measurement that cannot happen.
  function configured() {
    try {
      var config = window.WANTNOT_ANALYTICS;
      if (!config || typeof config !== 'object') return false;
      var site = typeof config.site === 'string' ? config.site.trim() : '';
      var provider = typeof config.provider === 'string' ? config.provider.trim() : '';
      return !!site && Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, provider);
    } catch (err) {
      return false;
    }
  }

  function bodyText(text) {
    if (!configured()) return text.inert;
    return text.measured.replace('{provider}', PROVIDER_LABELS[configuredProvider()]);
  }

  function configuredProvider() {
    try {
      return String((window.WANTNOT_ANALYTICS || {}).provider || '').trim();
    } catch (err) {
      return '';
    }
  }

  // ---- the stored answer ---------------------------------------------------

  function readState() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return 'unset';
      var parsed = JSON.parse(raw);
      return parsed && (parsed.state === 'accept' || parsed.state === 'reject')
        ? parsed.state
        : 'unset';
    } catch (err) {
      return 'unset';
    }
  }

  function writeState(state) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        state: state,
        at: new Date().toISOString()
      }));
    } catch (err) {
      // Blocked storage: the answer stands for this visit, the banner asks
      // again next time.
    }
  }

  // ---- the banner ----------------------------------------------------------

  var listeners = [];
  var opener = null;

  function action(text, answer) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-consent-' + answer, '');
    btn.textContent = text;
    btn.addEventListener('click', function () { answer === 'accept' ? choose('accept') : choose('reject'); });
    return btn;
  }

  function build(text) {
    var section = document.createElement('section');
    section.className = 'consent';
    section.setAttribute('data-consent', '');
    section.setAttribute('role', 'region');
    section.setAttribute('aria-label', text.label);
    section.hidden = true;

    var sheet = document.createElement('div');
    sheet.className = 'sheet';

    var say = document.createElement('p');
    say.className = 'say';
    var lead = document.createElement('b');
    lead.textContent = text.lead;
    var link = document.createElement('a');
    link.href = POLICY_HREF;
    link.textContent = text.link;
    say.appendChild(lead);
    say.appendChild(document.createTextNode(' ' + bodyText(text) + ' '));
    say.appendChild(link);
    say.appendChild(document.createTextNode(text.tail));

    var acts = document.createElement('div');
    acts.className = 'acts';
    acts.appendChild(action(text.accept, 'accept'));
    acts.appendChild(action(text.reject, 'reject'));

    sheet.appendChild(say);
    sheet.appendChild(acts);
    section.appendChild(sheet);
    return section;
  }

  var banner = build(copy());

  function show() {
    banner.hidden = false;
    if (!opener) return;
    // Reopened from the page control: put the keyboard reader on the actions.
    var first = banner.querySelector('.acts button');
    if (first) first.focus();
  }

  function hide() {
    banner.hidden = true;
  }

  function choose(answer) {
    writeState(answer);
    hide();
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](answer);
      } catch (err) {
        // A subscriber's failure is the subscriber's problem, not the page's.
      }
    }
    if (opener) opener.focus();
  }

  // The page's footer control reopens the banner.
  function wireOpeners() {
    var nodes = document.querySelectorAll('[data-consent-open]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].addEventListener('click', function (event) {
        event.preventDefault();
        opener = event.currentTarget;
        show();
      });
    }
  }

  wireOpeners();
  document.body.appendChild(banner);
  if (readState() === 'unset') show();

  // The seam analytics.js reads. `state` is live; `onChange` returns an
  // unsubscribe.
  window.WantNotConsent = {
    get state() { return readState(); },
    onChange: function (fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      };
    }
  };
})();
