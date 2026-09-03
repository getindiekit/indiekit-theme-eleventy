import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import { resolveDate } from "./_11ty/dateResolver.js";
import { loadSiteConfig } from "./_11ty/siteConfig.js";
import pluginSass from "./_11ty/sassPlugin.js";
import pluginSyntaxHighlight from "./_11ty/syntaxHighlightPlugin.js";
import pluginImage, { OG_CARD_TEMPLATE } from "./_11ty/imagePlugin.js";
import pluginImageAvatar from "./_11ty/imageAvatarPlugin.js";
import pluginWebmentions from "./_11ty/webmentionsPlugin.js";
import pluginWebc from "@11ty/eleventy-plugin-webc";
import { feedPlugin } from "@11ty/eleventy-plugin-rss";
import markdownItToc from "markdown-it-table-of-contents";
import { IdAttributePlugin } from "@11ty/eleventy";
import fontAwesomePlugin from "@11ty/font-awesome";

// Site identity comes from _data/site.json, not hardcoded here (source read
// siteData the same way). site.json's url has no trailing slash; the feed
// plugin's `base` needs one — add it explicitly rather than relying on luck.
const siteData = loadSiteConfig();
const feedBase = siteData.url.endsWith("/") ? siteData.url : `${siteData.url}/`;

// Source (zachleat.com, eleventy.config.js:28,71) registers this as global
// data rather than a plain boolean so templates can read it through the data
// cascade like any other value. Our layouts (base.liquid, default.liquid)
// already carry the three `{% if JS_ENABLED %}` guards ported from the
// source — this was the missing half: the guards existed with nothing ever
// defining the name, so every guarded block was permanently suppressed.
const JS_ENABLED = true;

// Source (zachleat.com, eleventy.config.js:30-32) resolves its npm-package
// static assets (e.g. @zachleat/pagefind-search, @zachleat/heading-anchors)
// through real module resolution rather than a hand-built node_modules path
// — reproduced verbatim, same idiom used for both packages there.
function resolveModule(name) {
  return fileURLToPath(import.meta.resolve(name));
}

export default function (eleventyConfig) {
  // The real output directory for this run.
  //
  // eleventy.after's `dir.output` reports the directory configured at the
  // bottom of this file and ignores a CLI `--output=` override; `directories
  // .output` honours it (verified: with --output=_probe-out, dir.output was
  // "_site" while directories.output was "./_probe-out/"). Anything an after
  // hook writes must use the latter, or a build aimed elsewhere silently writes
  // into _site — which is exactly what happened: `npm run demo --output=
  // _site-demo` left the demo with no search index and no sitemap, and wrote
  // both into the directory the test suite reads.
  const outputDirOf = ({ dir, directories }) =>
    String(directories?.output || dir?.output || "_site").replace(/\/+$/, "");

  eleventyConfig.addGlobalData("JS_ENABLED", () => JS_ENABLED);

  // Task 17 (§1.6, source eleventy.config.js:75-88). Micropub sends
  // `post-status: draft` as a JF2 property, but that string never reaches a
  // file under content/: verified against @indiekit/preset-eleventy's
  // getFrontMatter() (indiekit-origin/packages/preset-eleventy/lib/
  // post-template.js, the unpublished fork at ~/indiekit/
  // indiekit-preset-eleventy/lib/post-template.js, and the beta.28 build
  // actually installed in ~/indiekit/example-config-local/node_modules —
  // all three agree) — it converts `postStatus === "draft"` into a boolean
  // `draft: true` front-matter key and deletes `postStatus` before the file
  // is ever written. So this keys on `data.draft`, the same field name the
  // port source already uses, not `data["post-status"]`.
  //
  // Source always drops a draft, in every run mode. Its own commented-out
  // alternative at :84 is strictly better and is what this adopts instead:
  // a draft stays visible under `--serve`/`--watch` so an author can preview
  // it, and is dropped only from a `build` — keyed on the real
  // process.env.ELEVENTY_RUN_MODE (confirmed live in this project's own
  // Task 15 probe, not assumed), not a hand-maintained flag.
  // Stamped BEFORE _data/eleventyComputed.js runs, so it sees the author's raw
  // front matter. eleventyComputed synthesises a "<Type> · <date>" title for
  // titleless post types (the Atom feed requires a non-empty <title>), which
  // means anything reading data.title afterwards cannot tell a real title from
  // a generated one. Layouts use this flag to keep a synthesised heading in the
  // document for microformats and screen readers without rendering it as a hero
  // heading — "PHOTO · 30 AUG 2026" is not a page title.
  // Build the Pagefind search index as part of the build itself.
  //
  // This was a separate `npm run search-index` script, which broke the search
  // page twice: pagefind-search.js's connectedCallback() calls
  // replaceChildren() — removing the light-DOM fallback form — and then loads
  // /pagefind/pagefind-ui.js. If that directory is absent the component has
  // destroyed the fallback and cannot replace it, so the page renders empty.
  //
  // Chaining the script onto `npm run build` was not enough: several checks in
  // test/build.mjs run `npx @11ty/eleventy` directly, so `npm test` rebuilt
  // _site without the index and left the search page broken every time.
  // Running it from eleventy.after means every build, including a dev
  // server's first build, produces a working search page.
  //
  // Scoped to the six post-type directories so OG cards, the search page
  // itself and the homepage never enter the index.
  eleventyConfig.on("eleventy.after", async (hookArgs) => {
    const { runMode } = hookArgs;
    const outputDir = outputDirOf(hookArgs);
    // Dev mode: index once, not on every incremental rebuild. The search page
    // destroys its own fallback form before importing /pagefind/pagefind-ui.js,
    // so a dev server with no index shows an empty page and a console error.
    // Content edited during a serve session is not re-indexed until the next
    // full build; restart the server to refresh it.
    if ((runMode === "serve" || runMode === "watch") && existsSync(`${outputDir}/pagefind/pagefind.js`)) return;
    const { createIndex } = await import("pagefind");
    const { index } = await createIndex();
    await index.addDirectory({
      path: outputDir,
      // One directory deep, so only post permalinks (/<type>/<slug>/) are
      // indexed. The per-type listing pages at /<type>/ are lists, not
      // content — the same reason /archive/ and the homepage are excluded;
      // indexing them puts a page of other posts' titles into the results.
      glob: "{articles,bookmarks,likes,notes,photos,replies}/*/*.html",
    });
    await index.writeFiles({ outputPath: `${outputDir}/pagefind` });
  });

  eleventyConfig.addPreprocessor("real-title", "*", (data) => {
    data.title_isReal =
      Boolean(data.title) ||
      (data.postType === "bookmark" && Boolean(data.bookmarkOf));
  });

  eleventyConfig.addPreprocessor("drafts", "*", (data) => {
    if (data.draft) {
      if (data.draft === "ignore") {
        return false;
      }
      // Source unconditionally appends " (Draft)" to data.title. Several
      // Indiekit post types are titleless by design (_data/
      // eleventyComputed.js) and carry no `title` front matter at this
      // point — preprocessors run before eleventyComputed. Appending to
      // `undefined` would ship a literal "undefined (Draft)" title, so only
      // append when a real title exists.
      if (data.title) {
        data.title = `${data.title} (Draft)`;
      }
    }

    if (data.draft && process.env.ELEVENTY_RUN_MODE === "build") {
      return false;
    }
  });

  // Source also dev-gates eleventyConfig.ignores.add() for expensive page
  // sets outside production (:91-94: a network feed-aggregation page and an
  // OG-image page). This theme has no equivalent aggregation page, but
  // Task 20 adds the OG-image page set (content/opengraph-images.liquid,
  // one render per post) — same idea as source, same run-mode idiom this
  // repo already uses elsewhere (drafts above, IMAGE_CACHE_DURATION in
  // imagePlugin.js) rather than a second PRODUCTION_BUILD-style env var.
  // Under --serve/--watch this page set costs a full render per post for a
  // page nothing points at yet (og:image only uses it when a screenshot
  // service is configured — see _11ty/imagePlugin.js's cardsEnabled()), so
  // skip it there the same way source skips its own OG page set outside
  // PRODUCTION_BUILD.
  if (process.env.ELEVENTY_RUN_MODE !== "build") {
    eleventyConfig.ignores.add(OG_CARD_TEMPLATE);
  }

  // content/static/defer.js.liquid `{% include %}`s a dependency out of
  // node_modules (see that file's own comment for why it lives under
  // content/static/ rather than the source's project-root static/). Confirmed
  // empirically (not assumed): LiquidJS's Loader rejects a resolved include
  // path unless it is a descendant of one of the configured `root` entries
  // (liquidjs's fs.containsSync, via realpathSync) — this check runs
  // regardless of how many "../" segments are used or which subdirectory the
  // including template lives in. Eleventy's Liquid engine defaults `root` to
  // [dir.includes, dir.input] (Engines/Liquid.js) — neither contains
  // node_modules, because dir.input here is "content", not the project root.
  //
  // markdownTemplateEngine below is "liquid", so every post body — written by
  // a Micropub client, i.e. untrusted remote input — is rendered through
  // Liquid before markdown conversion. An earlier version of this config used
  // "." (the project root) as the third root entry, which restored reach to
  // node_modules for the include above but *also* let a post body's own
  // `{% include %}` read any project-root file (confirmed exploitable: a
  // note body containing `{% include "package.json" %}` rendered its
  // contents onto the published page). Scoped to the one package this build
  // actually needs instead — narrow enough that no other project-root file,
  // and no other npm package, is reachable this way.
  eleventyConfig.setLiquidOptions({
    // Matches the port source (eleventy.config.js:100-102). Without it Liquid
    // uses its own truthiness rules, where "" and 0 are TRUTHY — so a post with
    // an empty string field, or a genuine zero, branches the opposite way from
    // the source with nothing looking broken.
    jsTruthy: true,
    // Narrowed from the source's default. A "." root would let a Micropub-
    // authored post body {% include %} any project file; this reaches only the
    // one package the deferred bundle needs.
    root: ["_includes", "content", "node_modules/@11ty/is-land"],
  });

  // The Sass plugin needs the two configured colours to derive the token
  // ramps; siteData already carries site.json merged with any env override.
  eleventyConfig.addPlugin(pluginSass, { theme: siteData.theme });
  eleventyConfig.addPlugin(pluginSyntaxHighlight);
  eleventyConfig.addPlugin(pluginImage);
  eleventyConfig.addPlugin(pluginImageAvatar);
  eleventyConfig.addPlugin(pluginWebmentions);
  // Registered for its BUNDLER, not for components: base.liquid's
  // `{% getBundle 'css' %}` is this plugin's. _components/ was deleted
  // (finding 13), so the glob matches nothing today; it stays so a future
  // component is picked up without re-deriving the wiring.
  eleventyConfig.addPlugin(pluginWebc, { components: "_components/**/*.webc" });
  eleventyConfig.addPlugin(IdAttributePlugin);

  // Wire [[toc]] in markdown — ported from the port source
  // (eleventy.config.js:570-584). markdown-it-table-of-contents was already a
  // pinned dependency here but was never registered, so `[[toc]]` rendered as
  // literal text in a post body.
  //
  // The slugify is Eleventy's own built-in filter, exactly as the source does
  // it (`eleventyConfig.getFilter("slugify")`) — no extra dependency, and it
  // is the same slugifier IdAttributePlugin above uses to generate heading
  // ids, so the generated links actually resolve to the headings.
  eleventyConfig.amendLibrary("md", (mdLib) => {
    const slugify = eleventyConfig.getFilter("slugify");
    mdLib.use(markdownItToc, {
      includeLevel: [2, 3, 4],
      slugify: (str) => slugify(str),
      format: (heading) => heading,
      transformLink: (link) =>
        typeof link === "string" ? link.replace(/%60/g, "") : link,
    });
  });

  // Source (zachleat.com) passes { transform: false, shortcode: "icon",
  // defaultAttributes: {...} } — reproduced verbatim (paths/site identity
  // are the only things this theme changes; no icon markup uses this yet).
  eleventyConfig.addPlugin(fontAwesomePlugin, {
    transform: false,
    shortcode: "icon",
    defaultAttributes: {
      class: "z-icon",
      width: "20",
      height: "20",
    },
  });

  eleventyConfig.addPlugin(feedPlugin, {
    type: "atom",
    outputPath: "/feed.xml",
    collection: { name: "post", limit: 20 },
    metadata: {
      language: "en",
      title: siteData.name,
      subtitle: siteData.description,
      base: feedBase,
      // RFC 4287 §4.2.1 requires a non-empty atom:name, and atom:feed needs an
      // author unless every entry carries its own. This theme ships neutral
      // (site.json author.name is ""), and the plugin deep-merges metadata
      // over its own defaults, so BOTH obvious options are wrong:
      //   - passing author as-is  -> "" overrides the default -> <name></name>,
      //     invalid, on every clean checkout
      //   - omitting the key      -> the plugin's own default wins ->
      //     <name>Your Name</name>, valid but a lie
      // Fall back to the site's own name instead: valid, and truthful for an
      // unconfigured theme (the site is what published the entry). The atom
      // template reads only .name and .email (virtualTemplate.js:46-51) — there
      // is no author URI to supply here.
      author: {
        name: (siteData.author && siteData.author.name) || siteData.name,
        email: (siteData.author && siteData.author.email) || "",
      },
    },
  });

  // Micropub `category` -> tag pages (finding 6). Categories are arbitrary
  // strings written by whatever client published the post, so unlike the
  // source — which hardcodes a five-tag whitelist linking to a query-string
  // filter (post.liquid:75-81) — this derives the whole tag set from content.
  //
  // ONE slug implementation, used by both the collection (to build the
  // permalink) and the `slug` filter (to build the href). Two would drift and
  // produce links pointing at pages that were never built — exactly what the
  // internal-link guard in test/build.mjs exists to catch.
  const slug = (value) =>
    String(value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  eleventyConfig.addFilter("slug", slug);

  // Post dates, recorded while grouping post types below, for the sitemap's
  // lastmod. The sitemap is written from the eleventy.after hook (see further
  // down) because a collection cannot see pages that themselves consume
  // collections — the type indexes, /collections/ and every tag page were all
  // invisible to it — and the after hook has no access to template data. This
  // Map is the deliberate, documented bridge between the two.
  const postDates = new Map();

  // One group per post type, keyed by the URL segment posts of that type
  // actually live under (/notes/<slug>/ -> "notes"). Derived from post.url
  // rather than mapping postType "note" -> "notes" by hand: the directory data
  // files own the permalink scheme, so reading it back is the only way an index
  // cannot end up pointing somewhere its posts are not.
  eleventyConfig.addCollection("postTypes", (collectionApi) => {
    const groups = new Map();
    for (const item of collectionApi.getFilteredByTag("post")) {
      const segment = item.url.split("/").filter(Boolean)[0];
      if (!segment) continue;
      if (!groups.has(segment)) {
        groups.set(segment, { segment, postType: item.data.postType, posts: [] });
      }
      groups.get(segment).posts.push(item);
      if (item.date) postDates.set(item.url, item.date.toISOString());
    }
    // Newest first within a type, matching the archive's own ordering.
    for (const group of groups.values()) group.posts.reverse();
    return [...groups.values()].sort((a, b) => a.segment.localeCompare(b.segment));
  });

  eleventyConfig.addCollection("tagList", (collectionApi) => {
    const tags = new Map();
    for (const item of collectionApi.getFilteredByTag("post")) {
      for (const category of item.data.category || []) {
        const key = slug(category);
        if (!key) continue;
        if (!tags.has(key)) tags.set(key, { name: category, slug: key, posts: [] });
        tags.get(key).posts.push(item);
      }
    }
    // Newest-first within a tag, matching the archive's own ordering.
    for (const tag of tags.values()) tags.get(tag.slug).posts.reverse();
    return [...tags.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  // sitemap.xml, written from the finished output rather than a template.
  //
  // A template cannot produce a correct sitemap here: pages that consume
  // collections (the homepage, /archive/, the per-type indexes, /collections/,
  // every tag page) are either absent from collections.all or excluded from it,
  // so a template-rendered sitemap silently listed 13 of 25 pages — a valid
  // sitemap that quietly omits half the site. The after hook receives every
  // rendered result, which is the only complete view. Same mechanism as the
  // Pagefind index above, for the same reason.
  //
  // Protocol: sitemaps.org 0.9. `loc` must be absolute and entity-escaped;
  // `lastmod` must be W3C Datetime, which toISOString() satisfies. changefreq
  // and priority are omitted — both optional, both ignored by Google, and a
  // made-up priority on every page is noise. lastmod is emitted only for posts,
  // where the date means something: stamping listing pages with a build time
  // would claim the whole site changed on every build, and an inaccurate
  // lastmod is worse than none.
  //
  // The 50,000-URL / 50MB cap would need an Indiekit site to pass 50,000 posts
  // before it applied, at which point this wants splitting into a sitemap index.
  eleventyConfig.on("eleventy.after", async (hookArgs) => {
    const { results, incremental } = hookArgs;
    // `results` holds only the templates rebuilt in THIS pass, so on an
    // incremental build it is a handful of pages, not the site. Writing from it
    // there replaces a complete sitemap with a partial one — observed listing a
    // temporary test fixture and little else, five seconds after the full build
    // that had produced the correct file. Leave the last full build's sitemap in
    // place instead; a partial sitemap is worse than a slightly stale one.
    if (incremental) {
      return;
    }

    const escapeXml = (value) =>
      value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

    const base = siteData.url.replace(/\/$/, "");
    const urls = (results || [])
      .filter((result) => {
        if (!result.url || !result.outputPath?.endsWith(".html")) return false;
        // OG cards are renders for social scrapers, not pages. robots.txt
        // deliberately does not Disallow them — a crawler blocked from fetching
        // a page never sees the noindex inside it — so excluding them here is
        // what actually keeps them out of an index.
        if (result.url.startsWith("/opengraph/")) return false;
        if (result.url === "/404.html") return false;
        return !/<meta name="robots" content="noindex/.test(result.content || "");
      })
      .map((result) => result.url)
      .sort();

    const body = urls
      .map((url) => {
        const lastmod = postDates.get(url);
        return [
          "\t<url>",
          `\t\t<loc>${escapeXml(base + url)}</loc>`,
          ...(lastmod ? [`\t\t<lastmod>${lastmod}</lastmod>`] : []),
          "\t</url>",
        ].join("\n");
      })
      .join("\n");

    await writeFile(
      `${outputDirOf(hookArgs)}/sitemap.xml`,
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`,
    );
  });

  // webmention-avatar.liquid's fallback <img> references this path. Source
  // ships the same file at the same path via the same passthrough pattern.
  eleventyConfig.addPassthroughCopy("web/img");

  // Speedlify 2: the score widget footer.liquid links (static/js/*).
  // This ships the real, USED speedlify2-score.js — do not confuse it with the
  // health-score badge component, which was deleted (see below).
  eleventyConfig.addPassthroughCopy({ static: "/" });

  // Fixture media. In production Indiekit's media store writes uploads to
  // /media/, and post front matter references them at that URL — so the
  // fixtures use the real production path rather than a theme-local one.
  // Without this the photo post's <img> 404s: the src was correct and the
  // file was simply never copied into the build.
  eleventyConfig.addPassthroughCopy({ "content/_fixtures": "/media" });
  // Finding 13: _components/ (toggle-button.webc + its .css/.js, and
  // health-score.js) and the passthrough that published them to the site root
  // were deleted. Nothing referenced them: the component's only consumer was
  // the source's footer "turn CSS off / turn web fonts off" buttons, which
  // _includes/footer.html deliberately drops as source-specific, and the
  // mobile nav is a plain .navigation-toggle button with an inline script
  // (layouts/default.liquid). The footer's Speedlify widget uses
  // static/js/speedlify2-score.js, a different file, still shipped above.

  // Task 18 (§7.4): @zachleat/heading-anchors is a pinned dependency
  // (package.json) that nothing referenced until now. Source
  // (eleventy.config.js:181) copies it via resolveModule() into its own
  // "static/" output tree; this theme's {static: "/"} mapping above already
  // strips that "static/" prefix for every other vendored asset (see the
  // speedlify2-score.js comment above — `/js/...`, not `/static/js/...`), so
  // the equivalent output here is the bare root, not "static/heading-anchors.js".
  // default.liquid's `modules:` list is adapted to match (`/heading-anchors.js`,
  // not the source's `/static/heading-anchors.js`).
  eleventyConfig.addPassthroughCopy({
    [resolveModule("@zachleat/heading-anchors")]: "heading-anchors.js",
  });

  // The last two pinned-but-unreferenced dependencies, wired to the Indiekit
  // cases they actually fit rather than the source's:
  //
  // carouscroll — the source uses it for conference slide decks (its `slides`
  // shortcode paginates numbered slide images). No Indiekit equivalent, but a
  // photo post's `photo` is an ARRAY, so a multi-photo post is the carousel
  // case here.
  //
  // browser-window — the source wraps external link previews in browser
  // chrome. Bookmarks and replies point at external URLs; same affordance.
  eleventyConfig.addPassthroughCopy({
    [resolveModule("@zachleat/carouscroll")]: "carouscroll.js",
    [resolveModule("@zachleat/browser-window")]: "browser-window.js",
  });

  // Task 19 (§9.2): @zachleat/pagefind-search is the other pinned dependency
  // that nothing referenced until now. Same resolveModule() passthrough
  // idiom as heading-anchors above, same root-not-"static/" output path for
  // the same reason (this theme's {static: "/"} mapping strips that prefix
  // from every vendored asset). content/search.md's own inline
  // `<script type="module" src="/pagefind-search.js">` is adapted to match.
  eleventyConfig.addPassthroughCopy({
    [resolveModule("@zachleat/pagefind-search")]: "pagefind-search.js",
  });

  // Source (zachleat.com, eleventy.config.js:656-674) pins one timezone
  // across three date-parsing branches so YAML dates, ISO strings and a
  // fallback all resolve to the same wall-clock day — see
  // https://github.com/11ty/eleventy/issues/3668. Adapted for Indiekit:
  // (1) the zone comes from site.json, not a hardcoded "America/Chicago";
  // (2) Indiekit filenames are slug-based (no YYYY-MM-DD prefix), and
  // `@rmdes/indiekit-preset-eleventy` always writes a `date` front-matter
  // key (renamed from Micropub's `published`, deleting the original) —
  // so a file with no `date` at all is content this preset never
  // produces. The fallback instead looks for a literal `published:` key
  // in the file's own front matter, for content authored outside that
  // preset, reading the raw file the same way the source's regex reads
  // the raw filename.
  // No `timezone` key (a downstream consumer's site.json) falls back to
  // UTC rather than the build process's ambient zone — a fixed zone keeps
  // builds reproducible across machines, the same property this file exists
  // to give configured-timezone sites.
  const TIME_ZONE = siteData.timezone || "utc";

  // addDateParsing, and the isoInstant/humanDate filters below, all resolve
  // a page's `date` the same way — through the shared resolveDate() in
  // _11ty/dateResolver.js. They used to each hand-roll their own Date/string
  // branches; the filters' copy never grew the explicit-offset detection
  // addDateParsing did (see the task-11 coverage-gap report), so a zone-less
  // date rendered one instant on the page and a different one in the feed.
  // One function, one set of rules, called from every site this data flows
  // through.
  eleventyConfig.addDateParsing(function (dateValue) {
    return resolveDate(dateValue, this.page.inputPath, TIME_ZONE);
  });

  // _includes/types/*.liquid's `dt-published` datetime attribute used to be
  // `{{ date | date: '%Y-%m-%dT%H:%M:%SZ' }}` — that `Z` is a literal
  // strftime character, not a conversion: LiquidJS's `date` filter reads
  // hours/minutes/seconds off the JS Date in the *process's local*
  // timezone, so the attribute stamped local wall-clock time and then
  // asserted it was UTC. Emits true UTC instead, via Luxon rather than the
  // process's ambient timezone — correct regardless of what machine the
  // build runs on. Templates read the data cascade's raw `date` value
  // (addDateParsing's resolved value is never copied back onto it, only
  // onto `page.date` — see the addDateParsing comment above), which is a JS
  // Date for the common unquoted-front-matter case and a string otherwise;
  // resolveDate() handles both, and — via `this.page.inputPath`, which
  // LiquidJS filters get the same way addDateParsing's callback does — reads
  // the same front matter addDateParsing reads, so a zone-less date resolves
  // to the identical instant in both places.
  eleventyConfig.addLiquidFilter("isoInstant", function (dateValue) {
    const parsed = resolveDate(dateValue, this.page?.inputPath, TIME_ZONE);
    return parsed ? parsed.toUTC().toISO({ suppressMilliseconds: true }) : "";
  });

  // The human-readable date text next to `isoInstant`'s machine-readable
  // one (`{{ date | date: "%-d %B %Y" }}` in every _includes/types/*.liquid
  // partial) has the identical defect isoInstant was written to fix: LiquidJS's
  // `date` filter reads the JS Date's fields in the *build process's local*
  // timezone, so the same content renders a different calendar day depending
  // on where it's built. Same resolveDate() call as isoInstant above — only
  // the output format and target zone (TIME_ZONE for display, not UTC)
  // differ. Luxon's "d MMMM yyyy" is the token-for-token equivalent of
  // strftime's "%-d %B %Y" (unpadded day, full month name, 4-digit year).
  eleventyConfig.addLiquidFilter("humanDate", function (dateValue) {
    const parsed = resolveDate(dateValue, this.page?.inputPath, TIME_ZONE);
    return parsed ? parsed.setZone(TIME_ZONE).toFormat("d MMMM yyyy") : "";
  });

  // Listing rows get a SHORT date, because it sits in a fixed non-wrapping
  // column beside the dotted leader (sass/_theme-posts.scss). humanDate's
  // "30 August 2026" is 14 characters and wrapped to two and three lines there,
  // landing at a different x on every row.
  //
  // The year is emitted only when it is not the current one: the homepage lists
  // recent posts where the year is noise, but /archive/ and the tag pages span
  // years, where a bare "14 Mar" is ambiguous. The full date is always in the
  // adjacent <time datetime> attribute regardless, so nothing is lost to
  // machines or to a reader hovering the element.
  //
  // "Current" is evaluated in the SITE's timezone, not the build machine's —
  // otherwise a build running in a different zone flips the format a day early
  // or late around New Year, which is exactly the class of bug resolveDate()
  // and isoInstant were written to eliminate.
  // Serialise the computed JSON-LD object for a <script type="application/ld+json">.
  //
  // JSON.stringify does the escaping. The one thing it does NOT handle is that
  // an HTML parser ends a <script> at the first "</script>" ANYWHERE in the
  // text, including inside a JSON string — so "<" is escaped to \u003c, which
  // is still valid JSON and parses back to the same value.
  //
  // articleBody is added only for the Article-derived types; ImageObject is not
  // an Article and carries `caption` instead. The body is the rendered content
  // with tags stripped, because schema.org's articleBody is Text, not HTML.
  eleventyConfig.addFilter("jsonLdScript", (ld, content) => {
    if (!ld) {
      return "";
    }
    const isArticleLike = ld["@type"] === "Article" || ld["@type"] === "SocialMediaPosting";
    const body = String(content || "")
      // The generated table of contents is navigation, not body text — without
      // this, articleBody opens with the article's own heading list read as
      // prose. Its container holds only a <ul>, so a non-greedy match to the
      // closing </div> cannot swallow anything else.
      .replace(/<div class="table-of-contents">[\s\S]*?<\/div>/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const full = isArticleLike && body ? { ...ld, articleBody: body } : ld;
    return JSON.stringify(full).replace(/</g, "\\u003c");
  });

  eleventyConfig.addLiquidFilter("listingDate", function (dateValue) {
    const parsed = resolveDate(dateValue, this.page?.inputPath, TIME_ZONE);
    if (!parsed) {
      return "";
    }
    const inZone = parsed.setZone(TIME_ZONE);
    const currentYear = DateTime.now().setZone(TIME_ZONE).year;
    return inZone.toFormat(inZone.year === currentYear ? "d MMM" : "d MMM yyyy");
  });

  return {
    dir: {
      input: "content",
      output: "_site",
      includes: "../_includes",
      data: "../_data",
    },
    markdownTemplateEngine: "liquid",
    htmlTemplateEngine: "liquid",
  };
}
