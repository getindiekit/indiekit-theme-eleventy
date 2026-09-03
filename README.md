# indiekit-theme-eleventy-reference

An [Eleventy](https://www.11ty.dev/) theme built to be consumed by
[Indiekit](https://getindiekit.com/): Indiekit's Micropub endpoint writes
Markdown files into `content/`, and this theme turns them into a website.

It is a **port of [zachleat.com](https://github.com/zachleat/zachleat.com)**
— Zach Leatherman's personal site — adapted into a general-purpose Indiekit
theme. The source repo declares `"license": "MIT"` in its `package.json` but
ships no `LICENSE` file; this port carries that same MIT licensing forward,
and files translated closely from the source say so in a comment. Where a
piece of source code is used close to verbatim (for example
`static/js/speedlify2-score.js`, adapted from
[zachleat/speedlify-score](https://github.com/zachleat/speedlify-score)), the
upstream credit in that file is preserved — do not remove or reword it.

**Not ported**, because it's specific to Zach's own site rather than to the
theme: his content, analytics, fundraising, Kickstarter, ShopTalk, talk/
transcript pages, and his `eleventy-*.html` prose partials.

## Credit

This theme is a port, not original work. The design, the Sass, the layout
system, the webmention templates and most of the implementation are
[Zach Leatherman](https://zachleat.com/)'s, MIT licensed — as is Eleventy
itself, and 18 of the 24 dependencies this theme installs. It exists to serve
[Indiekit](https://getindiekit.com/) by Paul Robert Lloyd.

See [CREDITS.md](CREDITS.md) for full attribution and the upstream licence
notice, and [LICENSE](LICENSE) for this port's own terms.

## Who this is for

Anyone running Indiekit who wants an Eleventy front end with IndieWeb
features (webmentions, an Atom feed, syndication-friendly markup, an
Open Graph card per post, client-side search) without building one from
scratch.

## Post types

Indiekit writes each post under `content/<type>/<slug>.md`, one directory per
post type:

| Directory | Post type |
|---|---|
| `content/articles/` | article |
| `content/bookmarks/` | bookmark |
| `content/likes/` | like |
| `content/notes/` | note |
| `content/photos/` | photo |
| `content/replies/` | reply |

Eleventy's input directory is `content/`; the built site is written to
`_site/`.

## `_data/site.json` — the configuration surface

All site identity and feature configuration lives in `_data/site.json`.
Every key:

| Key | Purpose |
|---|---|
| `name` | Site name, used in the page `<title>`, feed title, and OG meta. |
| `url` | The site's canonical, publicly reachable URL (no trailing slash). Used for feed links, canonical URLs, and to decide whether OG screenshot cards can run (see below). |
| `description` | Default site/page description, used as a fallback for OG/Twitter meta. |
| `author.name`, `author.url` | Site owner identity. `author.url` also renders a `rel="me"` link for IndieAuth. |
| `timezone` | An IANA timezone name (e.g. `Europe/Brussels`). All dates render in this zone, regardless of what timezone the build machine is in, so a build is reproducible no matter where it runs. Falls back to UTC if unset. |
| `theme.primary`, `theme.secondary`, `theme.surface` | Six-digit hex. Every colour on the site is derived from these three; contrast is enforced, so a pale primary is darkened until links pass 4.5:1. Also settable as `INDIEKIT_COLOR_PRIMARY` / `_SECONDARY` / `_SURFACE`. |
| `theme.scheme` | `auto` (follows the visitor's OS), `light`, or `dark`. Dark is derived from the same three colours. |
| `theme.fonts.heading`, `.body`, `.mono` | Font-family lists. Defaults are the shipped Hex Franklin Tight and Lato; the shipped system fallbacks are appended automatically. A heading font other than the default also turns off the uppercase and variable-font treatment that belongs to Hex Franklin. |
| `theme.shape` | `sharp` (no radii, the logo's hard edges) or `rounded`. |
| `theme.rail.side`, `theme.rail.width` | `end` (right in LTR, the default) or `start`; a CSS length for the rail column. |
| `theme.measure` | Content column width, a CSS length. |
| `theme.signature.spectrum`, `.leader`, `.anchors` | The ported site's signatures: the rainbow edge strip, the dotted leader on listing rows, the `#` heading anchors. All on by default. |
| `speedlify.enabled` | Turns the `<speedlify2-score>` Lighthouse-score widget on or off, site-wide. |
| `speedlify.url` | Base URL of the Speedlify instance to query, e.g. `https://www.speedlify.dev/`. |

A bad value fails the build with a message naming the key, e.g. `site.json theme.scheme: expected light, dark or auto, got "dim"`.

A Speedlify instance is not a public submission service — it is a self-hosted
Eleventy project that measures a URL list its owner configures, published at
`<instance>/api/urls.json`. The badge is gated on that index
(`_data/speedlify.js`), so a page the instance does not measure renders no
badge rather than an empty box. `www.speedlify.dev` is the canonical public
instance but only covers its own curated set, so to get scores for your own
domain you run your own instance and point `speedlify.url` at it.

Build-time escape hatches, matching the other network-backed data files:
`SPEEDLIFY_OFFLINE=1` skips the fetch, and `SPEEDLIFY_FIXTURE=<path>` reads a
local `urls.json` instead. A disabled site never fetches at all.
| `opengraph.defaultImage` | The bundled fallback `og:image`/`twitter:image`, used whenever a screenshot card isn't available. |
| `opengraph.screenshotUrlTemplate` | A URL template (with a `{url}` placeholder) for an external screenshot service. When set **and** `site.url` is publicly reachable (not `localhost`, `127.*`, `0.0.0.0`, `::1`, or a private `10.*`/`192.168.*`/`172.16-31.*` address), `og:image` uses a generated screenshot card instead of the default image. A `localhost` URL can never be screenshotted by an external service, so this is skipped automatically rather than shipping a broken image link — check your build logs for a `[opengraph]` warning if it doesn't kick in. |

`_data/webmentionsBlockList.json` is a plain JSON array of source URLs to
suppress from the incoming webmentions list — it starts empty (`[]`) and is
the site owner's to populate as spam/abuse shows up.

## Running standalone

```sh
npm install
npm run build      # one-off production build to _site/
npm start           # eleventy --serve --incremental, dev server on :8090
npm run demo        # build with sample webmentions (see below)
npm run demo:serve  # same, with the dev server on :8090
npm test            # runs test/build.mjs against a real build
# (the search index is built automatically as part of every build)
```

### Previewing the populated state — `npm run demo`

A fresh checkout has no webmentions, so the parts of the theme that only appear
once a site has been out in the world — the like/repost/reply counts on listing
rows, the reposts/likes/bookmarks facepiles and the comment list on a
permalink — all render as nothing. That is correct, and it also makes them
impossible to look at, review, or restyle.

`npm run demo` builds the site against two fixtures, so everything that depends
on a site having been used renders at once:

- `test/fixtures/webmentions-demo.json` — 63 sample webmentions of all five
  types (`like-of`, `repost-of`, `in-reply-to`, `mention-of`, `bookmark-of`),
  spread unevenly across the fixture posts so both the populated and the empty
  case appear in the same build.
- `test/fixtures/site-demo.json` — a configured identity, so the representative
  h-card, `rel=me`, `rel=author`, `fediverse:creator` and the feed author all
  render. Supplied through `SITE_FIXTURE`, which deep-merges over
  `_data/site.json` at load time (`_11ty/siteConfig.js`); the committed default
  is never modified.

`SITE_FIXTURE` reaches templates through `_data/eleventyComputed.js`'s computed
`site` — computed data is the only tier that outranks a `_data/*` global — and
reaches the build config and data files through the same loader, so an overlaid
build cannot render one identity in the markup and another in the feed.

The fixture deliberately does not override `site.url`: the webmention fixture's
targets are absolute, so changing the origin would silently zero every count.

### Previewing a different palette

The colour inputs are environment variables, and `npm run demo` passes the
environment through, so any palette can be previewed without editing anything:

```sh
INDIEKIT_COLOR_PRIMARY="#0d7d7d" INDIEKIT_COLOR_SURFACE="#fdf6ec" npm run demo
npm run demo    # back to the committed default (Indiekit purple on white)
```

```sh
SITE_FIXTURE=test/fixtures/theme-knobs.json npm run demo   # every knob at its non-default: dark, rounded, rail on the left, no signatures
```

Every surface follows from the three colour values — links, the site title, borders,
the dotted leader, muted text, focus rings, the active nav pill and the h-card.
Contrast is enforced while it happens: a primary too pale to read is darkened
until it meets 4.5:1 rather than shipped as configured, so no combination
produces an unreadable site.

Two things deliberately do NOT follow the brand, because their colours carry
information rather than identity: the syntax-highlighting palette (which encodes
language grammar) and the social-count pill (whose three segments distinguish
boosts, likes and replies). Deriving either from one hue would render those
distinctions in a single colour.

```sh
npm run demo:serve      # then open /articles/fixture-article/
```

The demo builds to **`_site-demo/`**, not `_site/`. That separation is
deliberate: the test suite reads whatever is in `_site`, so a demo build left
there makes guards fail for the right reason but the wrong cause — the feed
names the fixture's author rather than the neutral default, and `demo:serve`'s
watcher keeps rewriting the directory mid-run. Two output directories means the
populated preview and the suite can never collide.

That page carries the fullest set: 6 reposts, 14 likes, 2 bookmarks and 3
comments. Nothing is fetched at build time — the fixture is read from disk, so
the demo works offline. Avatars are resolved client-side by
`v1.indieweb-avatar.11ty.dev` and degrade to a fallback when unreachable.

The fixture is sample data for previewing, **not** test data: the suite reads
`test/fixtures/webmentions.json`, which is separate and asserted against.

`node_modules` must exist before building — the deferred JS bundle
`{% include %}`s `@11ty/is-land` directly out of `node_modules`, so
`npm install` is not optional even for a "just render the templates" build.

### Drafts

When Indiekit is configured with `post-status: draft`,
`@indiekit/preset-eleventy` converts that into a `draft: true` front-matter
key on the file it writes (not a literal `post-status` field — verified
against the preset's own template code). This theme:

- **drops** draft posts entirely from a production build (`npm run build` /
  `npx @11ty/eleventy`);
- **keeps** them visible under `npm start` (`--serve`/`--watch`), so an
  author can preview a draft before publishing;
- marks a visible draft's title with a trailing `(Draft)` suffix so it's
  never mistaken for a published post while previewing.

### Two CSS bundles

- `content/_css/initial.scss` is the above-the-fold critical CSS. In a
  production build it's compiled and **inlined** directly into a `<style>`
  tag on every page. Under `--serve` it's instead linked as a normal
  stylesheet (`/_css/initial.css`) — livereload can't hot-swap an inlined
  `<style>` block, so dev mode trades the inlining for a working live reload.
- `content/_css/defer.scss` is everything else. It's loaded non-blocking
  (`media="print"` swapped to `all` on load) with a `<noscript>` fallback
  `<link>` for visitors without JavaScript.

### `JS_ENABLED`

`eleventy.config.js` sets a global `JS_ENABLED` flag (currently hardcoded
`true`) that gates every script-emitting block in the layouts, including the
deferred module bundle that loads `<is-land>` (`@11ty/is-land`) for
client-side progressive enhancement (search, heading anchors, etc.).

## Search

Search is client-side, powered by [Pagefind](https://pagefind.app/), and
**requires JavaScript** — there is no server-side search fallback. The
`/search/` page ships a plain, unguarded `<form>` for visitors without JS, so
the page never looks broken, but it won't actually return results until
Pagefind's client bundle loads.

The index is built as part of the build itself, from an `eleventy.after` hook,
so there is no separate step to forget:

```sh
npm run build          # builds the site and its search index into _site/
```

This matters more than it looks. `pagefind-search.js` replaces its own light-DOM
children before loading Pagefind's UI — so if the index is missing, the
component has already removed the no-JS form and cannot replace it, and the
page renders empty. Indexing from the build means that cannot happen. Indexing
is skipped under `--serve`, where the cost is not worth it.

## Open Graph cards

Every built post gets an `og:image`/`twitter:image`. Which mechanism it uses
depends on configuration:

- By default, every page uses the bundled static `opengraph.defaultImage`.
- If `opengraph.screenshotUrlTemplate` is configured **and** `site.url` is a
  publicly reachable address, `og:image` instead points at a generated
  per-post OG card page (`content/opengraph-images.liquid`, one render per
  built, non-draft post) via the screenshot service.
- A `localhost` (or other private/loopback) `site.url` can never be
  screenshotted by an outside service, so the screenshot mechanism is
  skipped automatically and the default image is used instead — this is by
  design, not a bug, and it's logged.

The OG card page set only builds in **production build mode**
(`npx @11ty/eleventy`, no `--serve`) — under `--serve` it's skipped entirely,
since nothing needs it there and it costs a full extra render per post.

## Testing

```sh
npm test
```

Runs `test/build.mjs`, which does its own build(s) against `_site/` and
asserts against the output. Two things affect which checks run and how many
pass:

- **`WEBMENTIONS_FIXTURE=test/fixtures/webmentions.json`** — points the
  webmentions data file at a local fixture instead of calling the
  webmention.io API. Without it, tests that need webmention data are
  skipped rather than making a real network call.
- **`NPM_DOWNLOADS_OFFLINE=1`** — short-circuits the npm download-count
  data file instead of calling the npmjs.org API.

```sh
# With no env vars (network reachable): 74/74 checks passed, 3 skipped
npm test

# Fully offline: 77/77 checks passed, 0 skipped
NPM_DOWNLOADS_OFFLINE=1 WEBMENTIONS_FIXTURE=test/fixtures/webmentions.json npm test
```

A plain local `npm test` (no env vars) needs `registry.npmjs.org` to be
reachable — the npm-downloads assertion is deliberately discriminating
about what a real API response looks like, so it fails outright rather than
silently passing against nothing if the network is down or flaky. That's an
accepted trade for local runs; CI always sets `NPM_DOWNLOADS_OFFLINE=1` so it
never depends on the network at all (see below).

Always `rm -rf _site` before treating a build as a clean baseline — Eleventy
reuses `_site/` incrementally, so a stale directory can hide a regression.

## Consumed as a submodule

This theme is designed to be added to an Indiekit config repo (such as
`example-config-local`) as a **git submodule**, alongside a small
build-watcher + static-file-server pair — the same pattern the project's
other starters use: a `site` service that runs `npm install && npx @11ty/eleventy --watch`
against the submodule directory, and a `static` service that serves the
resulting `_site/` output. The theme itself has no opinion on how it's
served in that setup; it only needs `content/` to be where Indiekit writes
files and `_site/` to be where the static server points.

## Eleventy version

This theme pins **`@11ty/eleventy` `4.0.0-alpha.10`** exactly, deliberately
— not a caret range. Eleventy 4 is still in alpha; the other Indiekit
starters (Hugo, Jekyll, and the plain Eleventy starter) remain on Eleventy
3.x. This theme intentionally tracks the newer major version, which means
its dependency versions may need re-verifying against each new Eleventy 4
alpha/beta release rather than upgrading automatically.

No dependency in this repo is added, removed, re-versioned, or imported
transitively without deliberately updating `package.json` — treat the
current dependency set as pinned.
