---
layout: layouts/default.liquid
tmpl: page
title: Search
---

<h1 class="primary-title">{{ title }}</h1>

{% comment %}
Task 19 (§9.2). Ported from /home/rmdes/zachleat.com/search.html, adapted:

- Source: `<link rel="stylesheet" href="/pagefind/pagefind-ui.css">` — a
  static top-level stylesheet link. Dropped here, not carried over.
  node_modules/@zachleat/pagefind-search/pagefind-search.js:88-91 shows the
  custom element's own connectedCallback() already creates and appends this
  exact <link> at runtime once it upgrades, so the static copy is redundant
  whenever JS runs. And whenever JS does NOT run, Pagefind's UI never
  renders either, so nothing on the page needs pagefind-ui.css at all — the
  no-JS fallback below is a plain <form>. A static reference would also
  point at /pagefind/, which this repo's search-index script (package.json)
  only builds separately from `npm run build` — the new asset-existence
  guard (test/build.mjs) would flag it as broken on every plain build. Not
  carrying it is correct, not just guard-convenient.
- Source: `<script type="module" src="/static/pagefind-search.js">`, gated
  on JS_ENABLED — same idea here, adapted to this theme's root-not-"static/"
  passthrough convention (eleventy.config.js, same as heading-anchors).
{% endcomment %}
{% if JS_ENABLED %}<script type="module" src="/pagefind-search.js"></script>{% endif %}

{% comment %}
`_page_size` / `_show_sub_results` / `pagefind-autofocus` are ported
verbatim — see @zachleat/pagefind-search's own README: any `_`-prefixed
attribute forwards to the PagefindUI constructor, and `pagefind-autofocus`
focuses the upgraded input.

The <form> below is the no-JS fallback: @zachleat/pagefind-search's
connectedCallback() only calls replaceChildren() (discarding these light-DOM
children) once it upgrades, which only happens if pagefind-search.js loads
— i.e. never, when JS_ENABLED is false or the visitor's browser has
scripting disabled. In both cases this form is what's actually rendered and
usable, with a real submit control, unconditionally (no JS_ENABLED guard
around it).

Source pointed this form's `action` at https://duckduckgo.com/ (an external
site-search query, with a hidden `sites` field restricting it to
zachleat.com) — that's the port source author's own choice of engine, and
this theme is meant to stay neutral: an Indiekit site owner should not have
a third-party search engine hardcoded on their behalf, and doing so would
also introduce an unrequested runtime dependency on that engine being up.
Instead this form's action is this same page's own URL ("/search/"): a
plain GET reload lands back here with `?q=<term>` in the address bar, which
is exactly what the deep-link handling below reads — so even without any
external engine, the no-JS fallback still produces a real, shareable,
bookmarkable search URL, and if the visitor's next request for that URL
does have JS available, `?q=` is picked up automatically and the search
actually runs. No dependency added; the site's own existing page does the
job.
{% endcomment %}
<pagefind-search _page_size="10" _show_sub_results="true" pagefind-autofocus>
	<form action="/search/" method="get">
		<label for="search-term" class="sr-only">Search Terms</label>
		<input type="search" name="q" id="search-term" autocomplete="off" autofocus>
		<button type="submit">Search</button>
	</form>
	<noscript>
		<p><strong>Search needs JavaScript.</strong> This site's index is built
		and queried in the browser by Pagefind, so there is no server to answer
		the form above — submitting it will simply reload this page. Browse
		<a href="/">the archive</a> instead.</p>
	</noscript>
</pagefind-search>

<p>Search powered by <a href="https://pagefind.app/">Pagefind</a>.</p>

{% comment %}
Task 19 (§9.2), ported near-verbatim from search.html:24-37: awaits
`scriptPromise` (resolves once pagefind-search.js has loaded the real
Pagefind UI), reads `?q=` off the current URL, and calls
`pagefindUI.triggerSearch(term)` — this is what makes a search URL
shareable/deep-linkable. Gated on JS_ENABLED (source did not gate this),
because a JS_ENABLED=false build is this theme's declared "ship no scripts"
mode (every other optional script in this theme — base.liquid's
defer.js, default.liquid's infinity-burger script — is gated the same way);
shipping this one inert inline <script> anyway would contradict that. It's
harmless either way at runtime — without pagefind-search.js,
`pagefindEl.scriptPromise` is undefined, `.pagefind-ui__search-input` never
exists, and the `if (term && searchEl)` guard below short-circuits — but
the build-time flag should still mean what it says.
{% endcomment %}
{% if JS_ENABLED %}
<script type="module">
let pagefindEl = document.querySelector("pagefind-search");

if (pagefindEl) {
	await pagefindEl.scriptPromise;
	let u = new URL(document.location);
	let searchEl = document.querySelector(".pagefind-ui__search-input");
	let term = u.searchParams.get("q");
	if (term && searchEl) {
		searchEl.value = term;
		pagefindEl.pagefindUI.triggerSearch(term);
	}
}
</script>
{% endif %}
