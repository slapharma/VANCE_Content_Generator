/* ═══════════════════════════════════════════════════════════════════════════
   VANCE MOBILE — shared behaviour for the mobile shell in vance-ui.css
   vance-mobile.js  v1.0.0

   The CSS half of the shell (`.v-drawer`, `.v-scrim`, `.v-burger`,
   `.v-bottomnav`) is in vance-ui.css. This is the ~10% that cannot be done in
   CSS: the ARIA state, Escape, the focus trap, and closing the drawer when the
   viewport grows past the breakpoint.

   Vendored, not packaged — same reasoning as lib/vance-sso.js. When changing
   this file, bump the version above and re-copy it to every repo;
   scripts/check-vendored.mjs will fail the build if a copy drifts.

   ── Everything is delegated from `document` ───────────────────────────────

   Deliberate, and the reason this file works unchanged in all three consoles.
   The Customer Service console is a single-page app that re-renders its whole
   shell into a fresh DOM on every navigation, so any listener bound directly
   to a button would be dead after the first click. Delegation means there is
   nothing to re-bind, no init to remember to call again, and no way for an
   app to half-adopt this.

   ── Usage ────────────────────────────────────────────────────────────────

     <button class="v-burger" data-v-drawer-toggle aria-expanded="false"
             aria-controls="sidebar" aria-label="Menu"> …icon… </button>
     <aside id="sidebar" class="sidebar v-drawer"> …existing nav… </aside>

   The scrim is created automatically; apps do not need to carry the markup.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* Must match the breakpoint in vance-ui.css. Repeated rather than shared
     because CSS custom properties are not readable from a media query and
     matchMedia is not readable from CSS — one of the two has to say the
     number twice. */
  var MOBILE = '(max-width: 859.98px)';

  var OPEN = 'v-drawer-open';
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), ' +
                  'select:not([disabled]), textarea:not([disabled]), ' +
                  'summary, [tabindex]:not([tabindex="-1"])';

  /** The element focus came FROM, so it can be given back on close. */
  var returnFocusTo = null;

  function drawer() { return document.querySelector('.v-drawer'); }
  function isOpen() { return document.body.classList.contains(OPEN); }
  function onMobile() { return window.matchMedia(MOBILE).matches; }

  /* The scrim is furniture, not content: it carries no information and exists
     only to catch a tap outside the drawer. Creating it here keeps it out of
     three sets of app markup, and guarantees it is a sibling of <body> rather
     than nested inside a stacking context that would trap it under the page. */
  function scrim() {
    var el = document.querySelector('.v-scrim');
    if (!el) {
      el = document.createElement('div');
      el.className = 'v-scrim';
      /* Not a control: it duplicates Escape and the burger, both of which are
         reachable, so exposing it would just add a stop to the tab order that
         reads as nothing. */
      el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(el);
    }
    return el;
  }

  function toggles() {
    return Array.prototype.slice.call(
      document.querySelectorAll('[data-v-drawer-toggle]')
    );
  }

  function open() {
    if (isOpen() || !onMobile()) return;
    var panel = drawer();
    if (!panel) return;

    returnFocusTo = document.activeElement;
    scrim();
    document.body.classList.add(OPEN);
    toggles().forEach(function (t) { t.setAttribute('aria-expanded', 'true'); });

    /* Focus the first real control inside, not the panel itself — a screen
       reader announces the control and its context, whereas focusing the
       container announces nothing and leaves the user unsure the drawer
       opened at all. Falls back to the panel when it is somehow empty. */
    var first = panel.querySelector(FOCUSABLE);
    if (first) {
      first.focus();
    } else {
      panel.setAttribute('tabindex', '-1');
      panel.focus();
    }
  }

  function close(restoreFocus) {
    if (!isOpen()) return;
    document.body.classList.remove(OPEN);
    toggles().forEach(function (t) { t.setAttribute('aria-expanded', 'false'); });

    /* Only when the user closed it deliberately. On a resize past the
       breakpoint, yanking focus back to a now-hidden burger would move the
       caret out from under someone who was simply rotating their phone. */
    if (restoreFocus && returnFocusTo && document.contains(returnFocusTo)) {
      returnFocusTo.focus();
    }
    returnFocusTo = null;
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-v-drawer-toggle]')) {
      e.preventDefault();
      if (isOpen()) close(true); else open();
      return;
    }

    if (e.target.closest('.v-scrim')) {
      close(true);
      return;
    }

    /* A tap on a destination inside the drawer. The drawer covers the content
       it just navigated to, so leaving it open would hide the result of the
       tap — the single most common complaint about off-canvas menus.

       `restoreFocus` is false here on purpose: focus belongs on the thing that
       was navigated to, and pulling it back to the burger would undo whatever
       the app's own router just did with it. */
    if (isOpen() && e.target.closest('.v-drawer a, .v-drawer [data-v-drawer-close]')) {
      close(false);
    }
  });

  document.addEventListener('keydown', function (e) {
    if (!isOpen()) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
      return;
    }

    if (e.key !== 'Tab') return;

    /* Focus trap. Without it, Tab walks straight out of the open drawer and
       into the page behind the scrim, where the user cannot see what is
       focused and every target is one they explicitly covered up. */
    var panel = drawer();
    if (!panel) return;

    var items = Array.prototype.filter.call(
      panel.querySelectorAll(FOCUSABLE),
      function (el) { return el.offsetParent !== null; }
    );
    if (!items.length) return;

    var first = items[0];
    var last = items[items.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  /* Rotating a phone to landscape, or dragging a desktop window wider, can
     cross the breakpoint while the drawer is open. The CSS stops styling it as
     a drawer at that point, but `body.v-drawer-open` — and with it
     `overflow: hidden` — would survive, leaving a page that silently refuses
     to scroll. This is the bug that makes hand-rolled drawers feel broken. */
  var mq = window.matchMedia(MOBILE);
  var onChange = function (e) { if (!e.matches) close(false); };
  if (mq.addEventListener) {
    mq.addEventListener('change', onChange);
  } else if (mq.addListener) {
    mq.addListener(onChange);        /* Safari < 14 */
  }

  /* Back/forward inside an SPA, and bfcache restores. */
  window.addEventListener('pagehide', function () { close(false); });
  window.addEventListener('popstate', function () { close(false); });

  /* ── Bottom-nav active state ─────────────────────────────────────────────
     Apps that navigate by URL get this for free; apps that switch views in
     JavaScript call vanceMobile.setActive(id) from their own router.
     ────────────────────────────────────────────────────────────────────── */
  function setActive(id) {
    var nav = document.querySelector('.v-bottomnav');
    if (!nav) return;
    Array.prototype.forEach.call(nav.querySelectorAll('[data-v-nav]'), function (el) {
      if (el.getAttribute('data-v-nav') === id) {
        el.setAttribute('aria-current', 'page');
      } else {
        el.removeAttribute('aria-current');
      }
    });
  }

  function syncFromLocation() {
    var nav = document.querySelector('.v-bottomnav');
    if (!nav) return;
    var here = location.pathname.replace(/\/+$/, '') || '/';
    Array.prototype.forEach.call(nav.querySelectorAll('a[href]'), function (a) {
      var path = a.getAttribute('href').split('#')[0].replace(/\/+$/, '') || '/';
      if (path === here) a.setAttribute('aria-current', 'page');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncFromLocation);
  } else {
    syncFromLocation();
  }

  window.vanceMobile = { open: open, close: close, setActive: setActive };
})();
