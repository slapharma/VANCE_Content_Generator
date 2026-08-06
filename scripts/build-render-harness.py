# -*- coding: utf-8 -*-
"""Build a render harness for index.html.

    python scripts/build-render-harness.py
    # then open _harness.html (gitignored) in a browser

This project has no local dev server — CLAUDE.md says verify by deploying — but
a full production deploy is a heavy way to find out that a stylesheet did not
load. The harness fills that gap for anything purely visual: it renders the app
shell and the static markup of all eighteen views from the working copy, so
layout, the sidebar cards, the header and the responsive breakpoints can be
looked at before anything ships.

It is NOT a functional test. Every page behind the sign-in screen draws its
contents from the API, and there is no API here, so the views render empty.

One caveat if you drive this from an automated browser: when the browser pane is
not compositing, existing elements return STALE values from getComputedStyle
after a class change. Insert a fresh element (or clone the one you care about)
and read that instead; getBoundingClientRect forces layout and stays honest.

What it changes, and nothing else:
  * root-relative asset paths -> paths relative to the repo, so file:// resolves
  * the auth overlays are removed, since there is no API to sign in against
  * fetch() is stubbed to reject fast, so boot code fails at the same points it
    would offline instead of hanging the page
"""
import io, os, re

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

s = io.open(os.path.join(REPO, 'index.html'), encoding='utf-8').read()

# 1. root-relative -> repo-relative (the harness is written INTO the repo)
s = s.replace('href="/vance-ui.css"', 'href="vance-ui.css"')
s = s.replace('href="/vance-cs.css"', 'href="vance-cs.css"')
s = s.replace('href="/fonts/', 'href="fonts/')
s = s.replace('src="/vance-mobile.js"', 'src="vance-mobile.js"')
s = s.replace('src="/vance-logo.png"', 'src="vance-logo.png"')

# 2. drop the boot cover and the sign-in overlay
s = re.sub(r'<div id="authBootCover".*?</div>\s*', '', s, count=1, flags=re.S)

# 3. stub the network so boot fails immediately rather than hanging, and force
#    the shell visible. Injected last so it runs after the app script.
HARNESS = '''
<script>
/* RENDER HARNESS — not part of the app. */
(function () {
  window.fetch = function () { return Promise.reject(new Error('harness: offline')); };
  function reveal() {
    ['authBootCover', 'loginOverlay', 'changePwdModal'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    document.body.dataset.role = 'admin';
    document.querySelectorAll('[data-require-role]').forEach(function (el) { el.style.display = ''; });
    var e = document.getElementById('whoamiEmail'); if (e) e.textContent = 'harness@slapharmagroup.com';
    var r = document.getElementById('whoamiRole');  if (r) r.textContent = 'admin';
    var de = document.getElementById('drawerEmail'); if (de) de.textContent = 'harness@slapharmagroup.com';
    var dr = document.getElementById('drawerRole');  if (dr) dr.textContent = 'admin';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ setTimeout(reveal, 60); });
  else setTimeout(reveal, 60);
  setInterval(reveal, 500);
})();
</script>
</body>'''
# LAST occurrence, not the first. index.html:9521 builds a slide-export document
# in a JS string literal that contains a literal </body>, so a first-match
# replace lands inside the app script and truncates a string — which shows up as
# "Uncaught SyntaxError: Invalid or unexpected token" and every global missing.
i = s.rindex('</body>')
s = s[:i] + HARNESS + s[i + len('</body>'):]

io.open(os.path.join(REPO, '_harness.html'), 'w', encoding='utf-8').write(s)
print('wrote', os.path.join(REPO, '_harness.html'))
