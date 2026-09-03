import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync, rmSync, globSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import Eleventy from "@11ty/eleventy";
import npmDownloads from "../_data/npmDownloads.js";

const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push(true);
    console.log(`ok   ${name}`);
  } catch (error) {
    checks.push(false);
    console.log(`FAIL ${name} — ${error.message}`);
  }
};

// fn may return a promise; await it so a rejection is caught here instead of
// becoming an unhandled rejection that lets the check "pass" while testing
// nothing. Callers must `await checkAsync(...)` — the checks array has to be
// fully populated before the pass/fail summary is computed at the bottom.
const checkAsync = async (name, fn) => {
  try {
    await fn();
    checks.push(true);
    console.log(`ok   ${name}`);
  } catch (error) {
    checks.push(false);
    console.log(`FAIL ${name} — ${error.message}`);
  }
};

check("builds an index page", () => {
  assert.ok(existsSync("_site/index.html"), "_site/index.html missing");
});

check("index carries its title", () => {
  const html = readFileSync("_site/index.html", "utf8");
  assert.ok(
    html.includes("Indiekit reference theme"),
    "title text not found in output",
  );
});

// The HTML-scraping counterpart of the check below used to live here. It
// asserted against `<p>downloads: N</p>` — a debug line rendered on the
// homepage purely so the assertion had something to read. Rendering test
// scaffolding to every visitor to satisfy a test is the wrong trade; the
// module-level contract check below tests the same data without it.
await checkAsync("npmDownloads data module returns a well-formed contract", async () => {
  // Complements the HTML check above by testing the contract at its source
  // rather than by scraping rendered markup — proves the module itself is
  // correct, independent of whether/how a template chooses to display it.
  const result = await npmDownloads();
  assert.ok(result && typeof result === "object", "npmDownloads() did not return an object");
  assert.ok(Number.isInteger(result.downloads), `downloads is not an integer: ${result.downloads}`);
  if (process.env.NPM_DOWNLOADS_OFFLINE) {
    assert.equal(result.downloads, 0, `offline mode must return exactly 0, got ${result.downloads}`);
  } else {
    assert.ok(result.downloads > 0, `expected a positive downloads count, got ${result.downloads}`);
  }
});

await checkAsync(
  "cache durations are keyed to Eleventy's real run mode, not a source-scanned constant",
  async () => {
    // Task 15: _data/webmentions.js, _data/npmDownloads.js and
    // _11ty/imagePlugin.js each export a cache-duration constant keyed off
    // process.env.ELEVENTY_RUN_MODE (or, for images, deliberately NOT keyed
    // — see the comment above IMAGE_CACHE_DURATION). A build-output
    // assertion can't see a cache duration, and a source-text scan for the
    // string "ELEVENTY_RUN_MODE" would pass even if the ternary read the
    // wrong branch, used the wrong variable, or the variable were never
    // actually set by Eleventy — exactly the class of vacuous check this
    // project has been burned by before ("setting an env var the code never
    // reads proves nothing" cuts the same way in reverse: finding the string
    // in source proves nothing about what value it evaluates to at runtime).
    //
    // process.env.ELEVENTY_RUN_MODE genuinely is Eleventy's real run mode
    // here, not a guessed/no-op var: verified by reading CoreMinimal.js
    // (initializeConfig -> initializeEnvironmentVariables ->
    // EnvironmentVars.cjs's setEnvValue("RUN_MODE", this.runMode)), which
    // runs before any _data/*.js file is imported, and independently by
    // probing it live — a throwaway _data/*.js file printed this var's value
    // from inside both a real CLI build and a real
    // `new Eleventy(input, output, { runMode: "serve" })` build, and both
    // matched the mode that produced them.
    //
    // So this drives two REAL Eleventy builds — one plain "build" mode, one
    // programmatic "serve" mode (same mechanism the "under serve mode" check
    // above uses) — and reads back the actual exported constants the
    // modules computed, sourced from the exact module instances Eleventy
    // itself imported for that build. Each build runs in its OWN child
    // process via a throwaway probe script, not inline here: Eleventy's
    // setEnvValue mutates process.env for the rest of THIS process's
    // lifetime, and doing that here would silently change
    // transformOnRequest/outputDir behaviour (_11ty/imagePlugin.js) for
    // every later execFileSync-spawned build in this file, which inherits
    // env by default — the same trap the "under serve mode" check's own
    // comment flags for why it uses the programmatic API in the first place.
    const probeScript = "_probe-run-mode.mjs";
    const probeSource = `import Eleventy from "@11ty/eleventy";

const mode = process.argv[2]; // "build" or "serve"
const outDir = process.argv[3];

const options = { source: "cli", quietMode: true };
if (mode === "serve") {
  options.runMode = "serve";
}
// mode === "build": omit runMode, matching a plain CLI invocation with no
// --serve/--watch flag (cmd.cjs:106 defaults to "build" the same way).

const elev = new Eleventy(undefined, outDir, options);
await elev.write();

const webmentions = await import("./_data/webmentions.js");
const npmDownloads = await import("./_data/npmDownloads.js");
const speedlify = await import("./_data/speedlify.js");
const imagePlugin = await import("./_11ty/imagePlugin.js");

process.stdout.write("\\nPROBE_RESULT:" + JSON.stringify({
  webmentions: webmentions.default.CACHE_DURATION,
  npmDownloads: npmDownloads.default.CACHE_DURATION,
  speedlify: speedlify.default.CACHE_DURATION,
  image: imagePlugin.IMAGE_CACHE_DURATION,
}) + "\\n");
`;

    const buildOutDir = "_site-runmode-probe-build";
    const serveOutDir = "_site-runmode-probe-serve";

    const runProbe = (mode, outDir) => {
      rmSync(outDir, { recursive: true, force: true });
      const stdout = execFileSync(
        process.execPath,
        [probeScript, mode, outDir],
        {
          stdio: "pipe",
          // Force offline regardless of how this test file itself was
          // invoked — this check must never touch the network.
          env: {
            ...process.env,
            WEBMENTIONS_FIXTURE: "test/fixtures/webmentions.json",
            NPM_DOWNLOADS_OFFLINE: "1",
          },
        },
      ).toString("utf8");
      const match = /PROBE_RESULT:(\{.*\})/.exec(stdout);
      assert.ok(match, `${mode}-mode probe produced no PROBE_RESULT line — got: ${stdout.slice(0, 500)}`);
      return JSON.parse(match[1]);
    };

    writeFileSync(probeScript, probeSource);
    try {
      const build = runProbe("build", buildOutDir);
      const serve = runProbe("serve", serveOutDir);

      assert.equal(
        build.webmentions,
        "2h",
        `build-mode webmentions cache duration: expected "2h", got ${JSON.stringify(build.webmentions)}`,
      );
      assert.equal(
        serve.webmentions,
        "30d",
        `serve-mode webmentions cache duration: expected "30d", got ${JSON.stringify(serve.webmentions)}`,
      );
      assert.notEqual(
        build.webmentions,
        serve.webmentions,
        "webmentions cache duration did not vary by run mode — it's a constant, not a switch",
      );

      assert.equal(
        build.speedlify,
        "1d",
        `build-mode speedlify cache duration: expected "1d", got ${JSON.stringify(build.speedlify)}`,
      );
      assert.equal(
        serve.speedlify,
        "30d",
        `serve-mode speedlify cache duration: expected "30d", got ${JSON.stringify(serve.speedlify)}`,
      );
      assert.notEqual(
        build.speedlify,
        serve.speedlify,
        "speedlify cache duration did not vary by run mode — it's a constant, not a switch",
      );

      assert.equal(
        build.npmDownloads,
        "1d",
        `build-mode npm downloads cache duration: expected "1d", got ${JSON.stringify(build.npmDownloads)}`,
      );
      assert.equal(
        serve.npmDownloads,
        "30d",
        `serve-mode npm downloads cache duration: expected "30d", got ${JSON.stringify(serve.npmDownloads)}`,
      );
      assert.notEqual(
        build.npmDownloads,
        serve.npmDownloads,
        "npm downloads cache duration did not vary by run mode — it's a constant, not a switch",
      );

      // Images are the deliberate exception (_11ty/imagePlugin.js): always
      // "*", in BOTH modes — proving the Task 15 deviation from the port
      // source was actually applied, not left as source's own keyed 1d/30d.
      assert.equal(
        build.image,
        "1d",
        `build-mode image cache duration: expected "1d", got ${JSON.stringify(build.image)}`,
      );
      assert.equal(
        serve.image,
        "30d",
        `serve-mode image cache duration: expected "30d", got ${JSON.stringify(serve.image)}`,
      );
    } finally {
      rmSync(probeScript, { force: true });
      rmSync(buildOutDir, { recursive: true, force: true });
      rmSync(serveOutDir, { recursive: true, force: true });
    }
  },
);

check("compiles sass to css", () => {
  // Scoped to this theme's own two bundles. An unscoped glob picks up
  // pagefind's shipped UI CSS (which animates) and opengraph.css,
  // neither of which this check is about.
  const css = [...globSync("_site/_css/initial.css"), ...globSync("_site/_css/defer.css")]
    .map((f) => readFileSync(f, "utf8")).join("");
  assert.ok(css.length > 0, "no .css file produced in _site");
});

// Task S1 (audit §4.3, §4.4): 7 @font-face rules and 2 preloads were
// declared with zero font files shipped and a passthrough-copy prefix
// mismatch, so every one of them 404'd — and no `body` rule named a
// font-family at all, so text rendered in the browser's default serif.
// These checks tie the declared hrefs/urls to real files on disk, and are
// written to FAIL (not vacuously pass) if they find zero preloads or zero
// @font-face rules to check — the exact failure mode this project has been
// burned by before.
check("every preloaded font resolves to a real file in _site", () => {
  const html = readFileSync("_site/index.html", "utf8");
  const hrefs = [
    ...html.matchAll(/<link\b[^>]*\brel="preload"[^>]*\bas="font"[^>]*>/g),
  ].map((m) => /\bhref="([^"]+)"/.exec(m[0])?.[1]);
  assert.ok(
    hrefs.length > 0 && hrefs.every(Boolean),
    "no <link rel=\"preload\" as=\"font\"> found — the check is vacuous",
  );
  for (const href of hrefs) {
    assert.ok(
      existsSync(`_site${href}`),
      `preloaded font href ${href} does not resolve to a real file in _site`,
    );
  }
});

// Only the two bundles base.liquid actually links for a real page
// (initial.css critical, defer.css deferred). _site/_css/opengraph.css is a
// wholly separate stylesheet for the OG card image renders — it has its own
// unrelated `body { font-family: system-ui... }` for that 1200x630 canvas,
// which would make these checks pass vacuously (right selector, wrong
// document) if the glob weren't scoped away from it.
const PAGE_CSS_GLOB = "_site/_css/{initial,defer}.css";

check("compiled CSS sets a body font-family", () => {
  const css = globSync(PAGE_CSS_GLOB)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  // Sass splits a selector's plain declarations and its @included nested
  // rule into separate output blocks for the same `body {}` selector (a
  // quirk of the webfont mixin's `& { ... }` wrapper) — so this must check
  // every `body { ... }` block, not just the first, for one that sets
  // font-family.
  const bodyRules = [...css.matchAll(/\bbody\s*\{[^}]*\}/g)];
  assert.ok(bodyRules.length > 0, "no `body { ... }` rule found in compiled page CSS");
  assert.ok(
    bodyRules.some((m) => /font-family\s*:/.test(m[0])),
    "compiled page CSS has body rule(s) but none sets font-family",
  );
});

check("every @font-face src referenced by compiled CSS resolves to a real file in _site", () => {
  const css = globSync(PAGE_CSS_GLOB)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const faceBlocks = css.match(/@font-face\s*\{[^}]*\}/g) || [];
  assert.ok(faceBlocks.length > 0, "no @font-face rules found in compiled CSS — the check is vacuous");
  const urls = faceBlocks.flatMap((block) =>
    [...block.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map((m) => m[1]),
  );
  assert.ok(urls.length > 0, "no font src urls found inside @font-face rules — the check is vacuous");
  for (const url of urls) {
    assert.ok(
      existsSync(`_site${url}`),
      `@font-face src ${url} does not resolve to a real file in _site`,
    );
  }
});

// Task S2 (audit §4.4, §4.7, §4.8; plan Task S2): no h1-h6, pre, code or
// figure rule existed anywhere in the port, and every link rendered the UA
// default #0000EE with no hover/focus feedback. These checks tie markup to
// styling per the task brief: a rule existing is not enough — a selector
// with no properties, or matched against the wrong stylesheet (see the
// opengraph.css trap noted on PAGE_CSS_GLOB above), proves nothing.
check("compiled CSS styles h1/h2 distinctly from body text", () => {
  const css = globSync(PAGE_CSS_GLOB)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.ok(css.length > 0, `${PAGE_CSS_GLOB} matched no files — check is vacuous`);

  const h1Rule = /\bh1\s*,\s*\.hed-h1\s*\{([^}]*)\}/.exec(css);
  assert.ok(h1Rule, "no `h1, .hed-h1 { ... }` rule found in compiled page CSS");
  assert.ok(
    /font-size\s*:/.test(h1Rule[1]),
    "h1's rule has no font-size — indistinguishable from body text",
  );

  const h2Rule = /\bh2\s*,\s*\.hed-h2\s*\{([^}]*)\}/.exec(css);
  assert.ok(h2Rule, "no `h2, .hed-h2 { ... }` rule found in compiled page CSS");
  assert.ok(
    /font-size\s*:/.test(h2Rule[1]),
    "h2's rule has no font-size — indistinguishable from body text",
  );
});

check("compiled CSS gives links a non-default colour with hover/focus feedback", () => {
  const css = globSync(PAGE_CSS_GLOB)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.ok(css.length > 0, `${PAGE_CSS_GLOB} matched no files — check is vacuous`);

  // The source styles links via `:link`/`:visited`, not a bare `a` selector
  // — `:link` matches the same rendered `<a href>` elements the UA default
  // #0000EE applies to.
  const linkRule = /:link\s*\{([^}]*)\}/.exec(css);
  assert.ok(linkRule, "no `:link { ... }` rule found in compiled page CSS");
  const colorMatch = /color\s*:\s*([^;]+);/.exec(linkRule[1]);
  assert.ok(colorMatch, "`:link` rule sets no color");
  assert.notEqual(
    colorMatch[1].trim().toLowerCase(),
    "#0000ee",
    "`:link` colour is still the UA default #0000EE",
  );

  assert.ok(
    /:link:active\s*,\s*:link:hover\s*,\s*:link:focus\s*,\s*:visited:hover\s*\{/.test(css),
    "no hover/focus rule for links — every link still only gets default browser feedback",
  );
});

check("compiled CSS gives pre/code a styled box", () => {
  const css = globSync(PAGE_CSS_GLOB)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.ok(css.length > 0, `${PAGE_CSS_GLOB} matched no files — check is vacuous`);

  // `code`/`pre` each compile to several separate blocks (mixins expand to
  // their own `& { ... }` rule — see the body font-family check above for
  // the same quirk), so scan every block rather than assume it's the first.
  const codeBlocks = [...css.matchAll(/\bcode\s*\{([^}]*)\}/g)];
  assert.ok(codeBlocks.length > 0, "no `code { ... }` rule found in compiled page CSS");
  assert.ok(
    codeBlocks.some((m) => /background-color\s*:/.test(m[1])),
    "no `code` rule sets background-color — inline code is indistinguishable from prose",
  );

  const preBlocks = [...css.matchAll(/\bpre\s*\{([^}]*)\}/g)];
  assert.ok(preBlocks.length > 0, "no `pre { ... }` rule found in compiled page CSS");
  assert.ok(
    preBlocks.some((m) => /background\s*:/.test(m[1])),
    "no `pre` rule sets background — code blocks would render on the page background with no padding or scroll",
  );
});

check("compiled CSS styles figure/figcaption", () => {
  const css = globSync(PAGE_CSS_GLOB)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.ok(css.length > 0, `${PAGE_CSS_GLOB} matched no files — check is vacuous`);

  const figureRule = /\bfigure\s*\{([^}]*)\}/.exec(css);
  assert.ok(figureRule, "no `figure { ... }` rule found in compiled page CSS");

  const figcaptionRule = /\bfigcaption\s*,\s*\.caption\s*\{([^}]*)\}/.exec(css);
  assert.ok(figcaptionRule, "no `figcaption, .caption { ... }` rule found in compiled page CSS");
  assert.ok(
    /font-size\s*:/.test(figcaptionRule[1]),
    "figcaption's rule has no font-size — indistinguishable from body text",
  );
});

check("image transform plugin produces optimised output", () => {
  // The transformed image lives in the article fixture's body — a content
  // image, which is what the transform is for. It used to be a bare <img>
  // hardcoded onto the homepage purely to give this check something to find.
  const html = readFileSync("_site/articles/fixture-article/index.html", "utf8");

  // A bare <img> is what eleventy-img leaves behind when the transform fails.
  // `failOnError` is false, matching the source plugin, so that fallback is
  // SILENT — asserting on <img> alone passes on an unoptimised image, which is
  // exactly what happened once during this port. Assert on artefacts only a
  // successful transform can produce.
  assert.ok(
    html.includes("<picture>"),
    "no <picture> element — the image transform did not run",
  );
  assert.ok(
    /<source[^>]+type="image\/avif"/.test(html),
    "no avif <source> — the transform produced no alternate formats",
  );
  assert.ok(
    globSync("_site/img/built/*.avif").length > 0,
    "no built .avif on disk under _site/img/built/",
  );
});

check("pages render through the base layout", () => {
  const html = readFileSync("_site/index.html", "utf8");
  assert.ok(html.startsWith("<!doctype html"), "output is not a full document");
  assert.ok(html.includes("</html>"), "output is not a full document");
});

check("a plain build produces a working search index", () => {
  // The search page broke twice. pagefind-search.js's connectedCallback calls
  // replaceChildren() — destroying the light-DOM fallback form — then loads
  // /pagefind/pagefind-ui.js. Absent that directory the component has removed
  // the fallback and cannot replace it, so the page renders empty.
  //
  // It was a separate npm script, so any build that did not also run it left
  // the page broken — including `npm test` itself, several of whose checks
  // rebuild _site with a bare `npx @11ty/eleventy`. Indexing now runs from
  // eleventy.after, so this asserts the index is present after whatever build
  // this suite just ran.
  for (const f of ["pagefind-ui.js", "pagefind-ui.css", "pagefind.js"]) {
    assert.ok(
      existsSync(`_site/pagefind/${f}`),
      `_site/pagefind/${f} missing — the search page will render empty`,
    );
  }
  const fragments = globSync("_site/pagefind/fragment/*");
  assert.ok(fragments.length > 0, "pagefind wrote no fragments — nothing was indexed");
});

check("every class the markup emits has a rule in the compiled CSS", () => {
  // This is the guard for the failure that made this theme ship visually
  // broken: 82 of its 107 CSS selectors targeted markup it never emitted, and
  // 23 of the 48 classes it did emit had no CSS at all — because the port took
  // the source's stylesheet and separately invented new markup. Every
  // structural test passed the whole time.
  //
  // Microformats classes are deliberately exempt: h-entry, e-content, u-photo
  // and friends carry MEANING, not styling — the source's own classes sit
  // alongside them and carry the visuals. Styling them would be the mistake.
  const mf2 = new Set([
    "h-entry", "h-feed", "h-card", "e-content", "p-name", "p-author",
    "u-url", "u-photo", "u-like-of", "u-in-reply-to", "u-bookmark-of",
    "dt-published", "u-syndication",
    // p-category carries a post's Micropub `category` values. Semantic, like
    // the rest of this list — the visible styling comes from the source's own
    // `.tags .tag` rule (_theme-chrome.scss:49), which sits alongside it.
    "p-category",
    // h-card vocabulary (partials/h-card.liquid). Semantic like the rest of
    // this list — the visible styling comes from the .h-card-* wrapper classes
    // beside them, which do have rules.
    "u-uid", "p-note", "p-job-title", "p-locality", "p-country-name",
    "p-org", "u-email", "u-key",
    // Core h-entry properties carried by partials/entry-meta.liquid. Semantic;
    // the visible styling is .entry-updated beside dt-updated, and p-summary
    // inherits the content column's own paragraph rules.
    "p-summary", "dt-updated",
    // Emitted by the webmention templates when fixture data is loaded:
    // h-cite is the mf2 vocabulary for a cited/quoted post, u-comment and
    // p-content are its properties. Semantic, like the rest of this list.
    "h-cite", "u-comment", "p-content",
  ]);
  // Unstyled in the port source too — its own webmentionlist.liquid uses these
  // exact class names with no Sass behind them. Faithful, not a gap.
  const unstyledInSource = new Set([
    "button", "hed-h4",
    // markdown-it-table-of-contents' default container. The source wires the
    // same plugin and never styles this class either — the generated <ul>
    // inherits the theme's list styling. Verified: zero occurrences in its
    // entire Sass tree.
    "table-of-contents",
  ]);

  const pages = globSync("_site/**/*.html").filter((f) => !f.includes("/opengraph/"));
  assert.ok(pages.length > 0, "no pages found — this check scanned nothing");
  const used = new Set();
  for (const file of pages) {
    for (const m of readFileSync(file, "utf8").matchAll(/class="([^"]+)"/g)) {
      for (const c of m[1].split(/\s+/)) if (c) used.add(c);
    }
  }
  assert.ok(used.size > 0, "no classes found in markup — this check is vacuous");

  // Scoped to this theme's own two bundles: an unscoped glob picks up
  // opengraph.css and pagefind's shipped UI CSS and manufactures a pass.
  const css = [...globSync("_site/_css/initial.css"), ...globSync("_site/_css/defer.css")]
    .map((f) => readFileSync(f, "utf8")).join("");
  assert.ok(css.length > 0, "no compiled CSS found — this check is vacuous");
  const defined = new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));

  // Font Awesome stamps its own hooks on the sprite <symbol> it generates
  // (`class="svg-inline--fa fa-reply-all"`, plugin output — not our markup).
  // Those are styled by FA's own stylesheet, which this theme does not ship and
  // does not need: the visible <svg> is sized by the ported `.z-icon` rule via
  // the shortcode's defaultAttributes. Matched by PREFIX so adding a second
  // icon later cannot re-break this check for a reason that is not a defect.
  const isFontAwesomeInternal = (c) => c === "svg-inline--fa" || c.startsWith("fa-");

  // Bridgy Publish's content classes (e-bridgy-<target>-content) are generated
  // from site.bridgy.targets, so the set is open-ended by design and cannot be
  // enumerated here. They are vocabulary for a third-party service, not styling
  // hooks — matched by prefix for the same reason the mf2 list exists.
  const isBridgyContent = (c) => /^e-bridgy-[a-z0-9-]+-content$/.test(c);

  const unstyled = [...used].filter(
    (c) =>
      !defined.has(c) &&
      !mf2.has(c) &&
      !unstyledInSource.has(c) &&
      !isFontAwesomeInternal(c) &&
      !isBridgyContent(c),
  );
  assert.deepEqual(
    unstyled.sort(),
    [],
    `classes emitted by the markup with no rule in the compiled CSS: ${unstyled.join(", ")}`,
  );
});

check("every internal link on every page resolves to something built", () => {
  // The nav shipped six hardcoded links copied from the port source's own
  // page list (/uses/, /domains/, /projects/, /web/speaking/) — all 404 here.
  // The existing asset guard only covered <script src> and <link rel=
  // stylesheet>, so nothing looked at <a href>. A theme that links to pages it
  // does not build is broken for every visitor, not just for a parser.
  const files = globSync("_site/**/*.html");
  assert.ok(files.length > 0, "no HTML produced — this check scanned nothing");
  const broken = [];
  let checked = 0;
  for (const file of files) {
    const html = readFileSync(file, "utf8");
    for (const m of html.matchAll(/<a\b[^>]*\shref="(\/[^"#?]*)/g)) {
      const href = m[1];
      checked++;
      const asDir = `_site${href.endsWith("/") ? href : `${href}/`}index.html`;
      const asFile = `_site${href}`;
      if (!existsSync(asDir) && !existsSync(asFile)) {
        broken.push(`${href} (linked from ${file})`);
      }
    }
  }
  assert.ok(checked > 0, "found no internal links to check — the scan is vacuous");
  assert.equal(
    broken.length,
    0,
    `internal links point at pages this theme never builds: ${[...new Set(broken)].join("; ")}`,
  );
});

check("no zachleat.com references leak into output", () => {
  // Scan every built page, not just the index. The index uses no entry
  // layout, so it can never see a leak confined to entry.liquid or the
  // includes it pulls in (e.g. webmentionlist.liquid's webmention.io form,
  // which only renders on entry pages).
  //
  // Also scan .js and .css, not just .html: Task 13 introduced a JS bundle
  // (content/static/defer.js.liquid) that inlines vendor source pulled out
  // of node_modules, and the port source concatenates more such vendor
  // files into the same bundle — a design that's built to grow. defer.js is
  // clean today; nothing would notice if a future addition stopped being.
  // Each glob is asserted non-empty on its own so a typo or an emptied
  // output directory for one extension can't silently pass by scanning
  // zero files of that type (matching the same guard already used for the
  // .html glob below).
    // Neutrality means this theme must not present the port author's IDENTITY
    // as its own — a personal domain in a form action, a name in a byline, a
    // hardcoded personal endpoint. It does NOT mean erasing credit to upstream
    // projects we vendor. Stripping an attribution comment out of third-party
    // source to make this check pass would be the wrong fix: it removes credit
    // the original author is owed and breaks byte-fidelity with the port
    // source. Such files are exempted BY PATH so the exemption is auditable
    // rather than a blanket substring carve-out.
    const attributionExempt = new Set([
    // Vendored from the port source; its header credits the upstream project
    // it derives from (github.com/zachleat/speedlify-score). Preserve it.
    "_site/js/speedlify2-score.js",
    ]);
  const extensions = { html: "_site/**/*.html", js: "_site/**/*.js", css: "_site/**/*.css" };
  for (const [ext, glob] of Object.entries(extensions)) {
    const files = globSync(glob);
    assert.ok(files.length > 0, `no .${ext} produced in _site — this check scanned nothing for that type`);
    for (const file of files) {
        if (attributionExempt.has(file)) continue;
      const text = readFileSync(file, "utf8");
      assert.ok(!text.includes("zachleat"), `found a zachleat reference in ${file}`);
    }
    // The exemption must not rot into a dead entry that silently covers
    // nothing: every exempted path has to actually exist in the build.
    for (const file of attributionExempt) {
      assert.ok(existsSync(file), `attribution-exempt file ${file} is not in the build — remove the stale exemption`);
      // The exemption covers ONE known upstream credit line. Pin the count so
      // a NEW identity leak added to this file later still fails, rather than
      // riding in under the exemption.
      const hits = (readFileSync(file, "utf8").match(/zachleat/g) || []).length;
      assert.equal(hits, 1, `${file} is attribution-exempt for exactly one upstream credit, found ${hits}`);
    }
  }
});

check("a post body cannot use Liquid include to read an arbitrary project-root file", () => {
  // eleventy.config.js sets markdownTemplateEngine: "liquid", so every post
  // body — written by a Micropub client, i.e. untrusted remote input — is
  // rendered through Liquid before markdown conversion. content/static/
  // defer.js.liquid legitimately needs a Liquid `root` entry that reaches
  // into node_modules (to {% include %} is-land.js); a `root` entry of "."
  // (the project root) satisfies that but also lets a post body {% include
  // %} any project-root file, e.g. secrets or deployment config. Prove a
  // post body cannot do that by having one try, via a canary file created
  // fresh here (not a real project file, so this check can't produce a
  // false pass by matching incidental substrings elsewhere in the build).
  const canaryPath = "SECURITY_TEST_CANARY.txt";
  const canaryToken = "CANARY_9f3d7c1b_do_not_leak";
  const fixturePath = "content/notes/fixture-note.md";
  const outDir = "_site-liquid-include-check";
  const originalFixture = readFileSync(fixturePath, "utf8");

  writeFileSync(canaryPath, `${canaryToken}\n`);
  writeFileSync(fixturePath, `${originalFixture}\n{% include "${canaryPath}" %}\n`);
  try {
    rmSync(outDir, { recursive: true, force: true });
    let buildError = null;
    try {
      execFileSync(
        process.execPath,
        ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
        { stdio: "pipe" },
      );
    } catch (error) {
    // LiquidJS's Loader rejects the include outright (it never resolves
    // inside an allowed root) and Eleventy fails the whole build rather
    // than writing a partial site — a hard failure is a legitimate way to
    // not leak the file, not just an empty output succeeding by accident.
    // Require the failure to actually name the blocked lookup, so an
    // unrelated crash can't be mistaken for the guard working.
      buildError = error;
      const output = `${error.stdout || ""}${error.stderr || ""}`;
      assert.ok(
        output.includes(canaryPath) && /ENOENT/.test(output),
        `build failed, but not because the include was blocked — got: ${output.slice(0, 500)}`,
      );
    }

    // Whether the build failed outright or completed, no output file may
    // contain the canary's contents.
    const producedFiles = globSync(`${outDir}/**/*`).filter((f) => statSync(f).isFile());
    for (const file of producedFiles) {
      const text = readFileSync(file, "utf8");
      assert.ok(!text.includes(canaryToken), `canary file contents leaked into ${file}`);
    }
    if (!buildError) {
      assert.ok(producedFiles.length > 0, "build reported success but produced no files to check");
    }
  } finally {
    writeFileSync(fixturePath, originalFixture);
    rmSync(canaryPath, { force: true });
    rmSync(outDir, { recursive: true, force: true });
    assert.equal(
      readFileSync(fixturePath, "utf8"),
      originalFixture,
      "content/notes/fixture-note.md was not restored to its original contents",
    );
  }
});

check("templates reading collections declare eleventyImport where it can take effect", () => {
  // A template that reads collections.* without `eleventyImport: {
  // collections: [...] }` reaching it through the *data cascade* (its own
  // front matter, or a layout in its chain — front matter merges up the
  // layout chain, Template.js:392,397 + TemplateMap.js) will not be rebuilt
  // by `--incremental` when a collection member changes elsewhere — a
  // silent stale-listing bug, not something a build-output assertion can
  // see. Source-scan instead.
  //
  // Critically: dir.input is "content" (eleventy.config.js), so files under
  // _includes/** are never their own TemplateMap entries — an `{% include
  // %}`d partial's own eleventyImport is inert (its front matter never
  // merges into the including page's data). A naive per-file scan flags the
  // partial itself; a developer "fixes" it by declaring eleventyImport on
  // the partial, the check goes green, and the real bug — the consuming
  // page still has no declaration — survives untouched. This check
  // attributes the requirement to the page/layout that can actually satisfy
  // it, resolving `{% include %}` and `layout:` chains (including layouts
  // assigned via a directory's *.11tydata.js, not just front matter).
  const templateFiles = globSync("{content,_includes}/**/*.{liquid,md,njk,html}");
  // Extended coverage (MEDIUM): the glob above misses directory-data
  // cascade files and WebC components — neither reads collections.* today,
  // but both are template-adjacent sources this check should watch.
  const dataFiles = globSync("content/**/*.11tydata.js");
  const webcFiles = globSync("_components/**/*.webc");
  assert.ok(
    templateFiles.length > 0,
    "template glob matched nothing — this check scanned nothing",
  );

  const srcCache = new Map();
  const src = (f) => {
    if (!srcCache.has(f)) srcCache.set(f, readFileSync(f, "utf8"));
    return srcCache.get(f);
  };

  const readsCollections = (text) => /collections\./.test(text);
  const declaresImport = (text) => /eleventyImport/.test(text);
  const isSelfOffender = (text) => readsCollections(text) && !declaresImport(text);

  // Exercise the primitive detectors against inline fixtures first, so a
  // "0 offenders" result below is backed by evidence they actually
  // distinguish an offender from a compliant or irrelevant file — not just
  // an empty result set (this repo currently has zero templates reading
  // collections.* at all, which would make the real scan pass "for free").
  assert.equal(
    isSelfOffender('{% for p in collections.post %}{% endfor %}'),
    true,
    "detector failed to flag a template reading collections.* with no eleventyImport",
  );
  assert.equal(
    isSelfOffender(
      '---\neleventyImport:\n  collections: ["post"]\n---\n{% for p in collections.post %}{% endfor %}',
    ),
    false,
    "detector flagged a template that already declares eleventyImport",
  );
  assert.equal(
    isSelfOffender("<p>no collections read here</p>"),
    false,
    "detector flagged a template that never reads collections.*",
  );
  // /collections\./ deliberately requires the dot, so bare prose mentioning
  // "collections" (e.g. base.liquid's comment about a `stylesheets`
  // collection) doesn't false-flag. A future comment written as literally
  // "collections.post" still could — accepted per the original tradeoff: a
  // spurious declaration is cheap, a missed one is a silent stale build.
  assert.equal(
    isSelfOffender("{% comment %}looped over collections it populated{% endcomment %}"),
    false,
    "detector flagged dot-less prose mentioning \"collections\"",
  );

  function frontMatter(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    return m ? m[1] : "";
  }
  function stripQuotes(s) {
    return s.trim().replace(/^["']/, "").replace(/["']$/, "");
  }
  function ownLayout(text) {
    const m = frontMatter(text).match(/^layout:\s*(.+)$/m);
    return m ? stripQuotes(m[1]) : null;
  }
  // A directory-data file (e.g. content/articles/articles.11tydata.js)
  // assigns `layout:` as a plain JS string literal in every case this theme
  // uses — read it the same lightweight way as front matter rather than
  // executing the module.
  function directoryDataLayout(text) {
    const m = text.match(/layout:\s*["']([^"']+)["']/);
    return m ? m[1] : null;
  }

  // Resolve an `{% include %}` target or a `layout:` value to the real file
  // under _includes/ it names (Eleventy resolves both relative to the
  // includes dir here — no separate dir.layouts is configured).
  function resolveIncludeTarget(name) {
    const clean = stripQuotes(name);
    const bare = `_includes/${clean}`;
    if (templateFiles.includes(bare)) return bare;
    for (const ext of [".liquid", ".html", ".njk", ".md"]) {
      const candidate = `${bare}${ext}`;
      if (templateFiles.includes(candidate)) return candidate;
    }
    return null;
  }
  function includesOf(text) {
    const names = [...text.matchAll(/{%-?\s*include\s+["']([^"']+)["']/g)].map((m) => m[1]);
    return [...new Set(names.map(resolveIncludeTarget).filter(Boolean))];
  }

  // Eleventy's directory-data cascade: for each ancestor directory between
  // content/ and a page's own directory, "<dir>/<dirName>.11tydata.js"
  // supplies default data (including `layout`) to every template in it.
  function directoryDataFilesFor(pagePath) {
    const parts = pagePath.split("/");
    const found = [];
    let dir = parts[0];
    for (let i = 1; i < parts.length - 1; i++) {
      dir += `/${parts[i]}`;
      const candidate = `${dir}/${parts[i]}.11tydata.js`;
      if (dataFiles.includes(candidate)) found.push(candidate);
    }
    return found;
  }

  // Walk a page's layout chain (own front matter first, directory-data
  // fallback, matching Eleventy's own specificity order), returning the
  // resolved _includes files, innermost first. Cycle-safe.
  function layoutChainOf(pagePath) {
    const chain = [];
    const seen = new Set([pagePath]);
    let layoutName =
      ownLayout(src(pagePath)) ||
      directoryDataFilesFor(pagePath).map((f) => directoryDataLayout(src(f))).find(Boolean);
    while (layoutName) {
      const layoutPath = resolveIncludeTarget(layoutName);
      if (!layoutPath || seen.has(layoutPath)) break;
      seen.add(layoutPath);
      chain.push(layoutPath);
      layoutName = ownLayout(src(layoutPath));
    }
    return chain;
  }

  // Every file whose body text actually executes when this page renders:
  // itself, its layout chain, and everything transitively `{% include %}`d
  // from any of those. This is the render set — collections.* read anywhere
  // in it is this page's problem to declare against, however deep the
  // partial that does the actual reading.
  function renderSetOf(pagePath) {
    const chain = layoutChainOf(pagePath);
    const seen = new Set([pagePath, ...chain]);
    const queue = [pagePath, ...chain];
    while (queue.length) {
      const f = queue.pop();
      for (const inc of includesOf(src(f))) {
        if (!seen.has(inc)) {
          seen.add(inc);
          queue.push(inc);
        }
      }
    }
    return seen;
  }

  // Data-cascade sources that can actually *satisfy* an eleventyImport
  // requirement for this page: its own front matter, its layout chain's own
  // front matter (propagates automatically), and any directory-data file
  // that applies. Deliberately excludes included partials — a partial's own
  // eleventyImport never merges into the including page's data, so it must
  // never count here (that's the exact blind spot this check exists to
  // close).
  function declarationSourcesOf(pagePath) {
    return [pagePath, ...layoutChainOf(pagePath), ...directoryDataFilesFor(pagePath)];
  }

  const pages = templateFiles.filter((f) => f.startsWith("content/"));
  assert.ok(pages.length > 0, "no content pages found — this check scanned nothing");

  const offenders = [];
  const reached = new Set();
  for (const page of pages) {
    const renderSet = renderSetOf(page);
    for (const f of renderSet) reached.add(f);
    const readerFile = [...renderSet].find((f) => readsCollections(src(f)));
    if (!readerFile) continue;
    const declares = declarationSourcesOf(page).some((f) => declaresImport(src(f)));
    if (!declares) {
      offenders.push(readerFile === page ? page : `${page} (reads collections.* via ${readerFile})`);
    }
  }

  // Safety net: an _includes template that reads collections.* but is
  // reachable from no page's render set is invisible to the loop above —
  // either genuinely dead code, or a sign include-resolution above missed a
  // real edge. Flag it rather than silently passing either way; the message
  // deliberately does not suggest declaring eleventyImport on the partial
  // itself, since that would not do anything.
  for (const f of templateFiles.filter((f) => f.startsWith("_includes/"))) {
    if (!reached.has(f) && readsCollections(src(f))) {
      offenders.push(
        `${f} (reads collections.* but is unreachable from any page's render set — ` +
          "dead code, or a missed {% include %}/layout edge; declaring eleventyImport on " +
          "this partial would not fix it, since partial front matter never merges into a page)",
      );
    }
  }

  // Directory-data files and WebC components have no partial-style blind
  // spot: a directory-data file's export merges into the cascade the same
  // as front matter, so it can satisfy its own requirement directly. WebC's
  // data-cascade/collections semantics aren't otherwise modelled here — the
  // simple self-check is what "extended coverage" means for these two.
  for (const f of [...dataFiles, ...webcFiles]) {
    if (isSelfOffender(src(f))) offenders.push(f);
  }

  assert.equal(
    offenders.length,
    0,
    `templates read collections.* without an eleventyImport declaration that reaches them: ${offenders.join("; ")}`,
  );
});

await checkAsync(
  "a page declaring eleventyImport is actually rebuilt incrementally; one that doesn't stays stale",
  async () => {
    // The source-scan check above proves templates are *annotated*
    // correctly; it can't prove Eleventy's incremental rebuilder actually
    // honors the annotation. Drive a real incremental build instead —
    // CLI's public `--incremental=<file>` flag (cmd.cjs:130-131) calls the
    // same `core.setIncrementalFiles()` the review pointed at in
    // CoreMinimal.js, and with no --watch/--serve it's a single write() and
    // exit (cmd.cjs:136-157) — no server, no port, no watcher.
    //
    // Three throwaway fixtures at content root: a tagged "member" page, a listing
    // that declares eleventyImport for that tag, and an identical listing
    // that doesn't. Full build, modify the member, rebuild incrementally,
    // and check which listing's *output file* actually changed.
    const outDir = "_site-incremental-check";
    const memberPath = "content/incremental-check-member.liquid";
    const declaredPath = "content/incremental-check-listing-declared.liquid";
    const undeclaredPath = "content/incremental-check-listing-undeclared.liquid";
    const declaredOut = `${outDir}/incremental-check-listing-declared/index.html`;
    const undeclaredOut = `${outDir}/incremental-check-listing-undeclared/index.html`;

    const memberBefore = `---
title: Original Title
tags: ["incrementalCheckMember"]
---
member
`;
    const declaredListing = `---
eleventyImport:
  collections: ["incrementalCheckMember"]
---
{% for item in collections.incrementalCheckMember %}{{ item.data.title }}{% endfor %}
`;
    const undeclaredListing = `{% for item in collections.incrementalCheckMember %}{{ item.data.title }}{% endfor %}
`;

    writeFileSync(memberPath, memberBefore);
    writeFileSync(declaredPath, declaredListing);
    writeFileSync(undeclaredPath, undeclaredListing);
    try {
      rmSync(outDir, { recursive: true, force: true });
      const run = (extraArgs) =>
        execFileSync(
          process.execPath,
          ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet", ...extraArgs],
          { stdio: "pipe", env: { ...process.env, NPM_DOWNLOADS_OFFLINE: "1" } },
        );

      run([]); // full build — establishes the baseline output

      assert.ok(existsSync(declaredOut), `${declaredOut} was not built`);
      assert.ok(existsSync(undeclaredOut), `${undeclaredOut} was not built`);
      assert.ok(
        readFileSync(declaredOut, "utf8").includes("Original Title"),
        "baseline build didn't render the member's title into the declaring listing",
      );
      assert.ok(
        readFileSync(undeclaredOut, "utf8").includes("Original Title"),
        "baseline build didn't render the member's title into the non-declaring listing",
      );

      writeFileSync(memberPath, memberBefore.replace("Original Title", "Updated Title"));
      run([`--incremental=${memberPath}`]); // real incremental rebuild, same output dir

      assert.ok(
        readFileSync(declaredOut, "utf8").includes("Updated Title"),
        "a page declaring eleventyImport for the changed collection was NOT rebuilt incrementally",
      );
      assert.ok(
        readFileSync(undeclaredOut, "utf8").includes("Original Title"),
        "a page reading the same collection with no eleventyImport unexpectedly updated — " +
          "this fixture no longer demonstrates the bug the guard exists to catch",
      );
    } finally {
      rmSync(memberPath, { force: true });
      rmSync(declaredPath, { force: true });
      rmSync(undeclaredPath, { force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  },
);

check("stylesheet carries real styling, not the placeholder", () => {
  const files = globSync("_site/**/*.css");
  assert.ok(files.length > 0, "no css produced");
  const css = files.map((f) => readFileSync(f, "utf8")).join("");
  assert.ok(css.length > 2000, `stylesheet is only ${css.length} bytes — still a stub?`);
  assert.ok(
    css.includes(".content-main") || css.includes("content-main"),
    "layout primitives missing — .content-main not compiled",
  );
});

check("the page links a stylesheet that actually exists", () => {
  const html = readFileSync("_site/index.html", "utf8");
  const links = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map((m) => m[0]);
  assert.ok(links.length > 0, "no stylesheet linked from the page at all");

  // Compiling CSS is not the same as loading it. The ported layout linked
  // /static/defer.css — a path from the source site that this theme never
  // builds — so the page 404'd while a full stylesheet sat unreferenced.
  for (const link of links) {
    const href = link.match(/href="([^"]+)"/)?.[1];
    assert.ok(href, `stylesheet link has no href: ${link}`);
    assert.ok(
      existsSync(`_site${href}`),
      `page links ${href}, which does not exist in _site`,
    );
  }
});

check("critical CSS is inlined, not render-blocking", () => {
  const html = readFileSync("_site/index.html", "utf8");
  assert.ok(/<style>[^<]*\.[a-z-]+\s*\{/i.test(html), "no inlined critical CSS found in <head>");
});

check("deferred CSS loads non-blocking with a noscript fallback", () => {
  const html = readFileSync("_site/index.html", "utf8");
  assert.ok(
    /rel="stylesheet"[^>]*media="print"[^>]*onload="this\.media='all'"/.test(html),
    "deferred stylesheet is not loaded with the media=print onload swap",
  );
  assert.ok(/<noscript>\s*<link[^>]*defer\.css/.test(html), "no <noscript> fallback for the deferred stylesheet");
});

await checkAsync(
  "under serve mode, critical CSS is linked (not inlined) and the linked file exists",
  async () => {
    // The two checks above only ever see build-mode output, where the
    // critical bundle is inlined and base.liquid's serve-only
    // `<link rel="stylesheet" href="/_css/initial.css">` branch is never
    // reached. If initial.css stopped being emitted, serve mode would 404
    // on that link while the suite stayed green. Drive a real serve-mode
    // build to exercise that branch.
    //
    // `--serve` on the CLI starts a dev server (watcher + port) — forbidden
    // here. `ELEVENTY_RUN_MODE` is read nowhere in this pinned alpha, so
    // setting it as an env var is a no-op (confirmed by hand, that's how
    // this exact branch was mistested before). The only way to reach
    // runMode "serve" without a server is programmatic: construct Eleventy
    // directly and call `.write()`, which CoreMinimal.js:152 takes as a
    // plain option with no watcher/socket/port attached.
    //
    // `source: "cli"` is not literal CLI invocation — it only tells
    // ProjectDirectories to freeze the explicit input/output we pass here
    // so eleventy.config.js's `dir.output: "_site"` can't win the race
    // (ProjectDirectories.js: "If input/output are set via CLI, they take
    // precedence over all other configuration values."). Confirmed by hand:
    // without it, this call silently writes into the real `_site` instead
    // of the throwaway dir below.
    const outDir = "_site-serve-check";
    rmSync(outDir, { recursive: true, force: true });
    try {
      const elev = new Eleventy(undefined, outDir, {
        source: "cli",
        quietMode: true,
        runMode: "serve",
      });
      await elev.write();

      const files = globSync(`${outDir}/**/*.html`);
      // Non-vacuous: a serve build that produced no HTML must fail this
      // check, not pass it by having nothing left to inspect.
      assert.ok(files.length > 0, "serve-mode build produced no HTML at all");

      const html = readFileSync(`${outDir}/index.html`, "utf8");
      const linkMatch = html.match(/<link[^>]+href="([^"]+_css\/initial\.css)"[^>]*>/);
      assert.ok(linkMatch, "serve-mode index.html does not link /_css/initial.css");
      const linkedFile = `${outDir}${linkMatch[1]}`;
      assert.ok(existsSync(linkedFile), `serve mode links ${linkMatch[1]}, which does not exist in ${outDir}`);

      // Distinguish the critical bundle from default.liquid's unrelated
      // "infinity-burger" <style> block (a hardcoded @media rule that also
      // renders on every page) by a marker unique to initial.scss's compiled
      // output and absent from defer.css.
      //
      // This was --z-border-radius-1, an arbitrary ported token that later
      // turned out to be dead and was removed — the check then failed because
      // its MARKER had gone, not because the bundle had. Anchored now to the
      // token layer's own declaration, which is structurally central: tokens
      // are emitted into critical deliberately (a token arriving in the
      // deferred sheet would mean a flash of unstyled colour), so if this
      // marker ever disappears from initial.css, that IS the regression.
      const criticalMarker = "--accent-500:";
      assert.ok(
        readFileSync(linkedFile, "utf8").includes(criticalMarker),
        `linked ${linkMatch[1]} does not contain the critical CSS — wrong file, or bundle regressed`,
      );
      const inlinedStyles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
      assert.ok(
        !inlinedStyles.some((s) => s.includes(criticalMarker)),
        "critical CSS is inlined under serve mode — livereload can't hot-swap this, defeating the point of the link",
      );
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  },
);

check("JS_ENABLED is defined and its guarded blocks emit", () => {
  const html = readFileSync("_site/index.html", "utf8");
  assert.ok(
    html.includes('src="/static/defer.js"'),
    "deferred module bundle not emitted — JS_ENABLED is falsy or undefined",
  );
});

check("the deferred bundle inlines the is-land loader", () => {
  assert.ok(existsSync("_site/static/defer.js"), "_site/static/defer.js missing");
  const js = readFileSync("_site/static/defer.js", "utf8");
  // Deviation from the task-13 brief's literal regex
  // (/customElements\.define\(\s*["']is-land["']/): verified empirically that
  // the installed @11ty/is-land@5.0.1 never contains that substring — its
  // static define() takes `registry = win.customElements` as a *default
  // parameter* and calls `registry.define(tagName, this)`, with `tagName`
  // assigned separately as the literal "is-land". A regex requiring the
  // literal text "customElements.define(" would fail forever against this
  // real dependency, indistinguishable from is-land never being included at
  // all — the false-negative trap this suite's own preamble warns about.
  // Pinned instead to the two statements the real source actually contains,
  // which only appear together if is-land.js's Island.define() body is
  // genuinely present (not merely a same-named stub or an empty file).
  assert.ok(
    /tagName\s*=\s*["']is-land["']/.test(js) && /registry\.define\(\s*tagName\s*,\s*this\s*\)/.test(js),
    "defer.js does not define the is-land custom element — islands will stay inert",
  );
});

check("navigation has an accessible mobile toggle", () => {
  const html = readFileSync("_site/index.html", "utf8");
  assert.ok(html.includes('class="navigation-toggle"'), "no nav toggle button");
  assert.ok(html.includes('aria-expanded="false"'), "toggle missing aria-expanded");
  assert.ok(html.includes('aria-controls="site-nav"'), "toggle not wired to the nav list");
  assert.ok(html.includes('id="site-nav"'), "nav list has no id to control");
  // The toggle is an ICON button. Its visible label was replaced by three CSS
  // bars, so the accessible name now depends entirely on the sr-only span —
  // drop that and the control becomes an unlabelled button to a screen reader.
  assert.ok(
    html.includes('class="navigation-toggle-icon"'),
    "nav toggle has no hamburger icon element",
  );
  assert.match(
    html,
    /<button[^>]*class="navigation-toggle"[\s\S]*?<span class="sr-only">\s*Menu\s*<\/span>[\s\S]*?<\/button>/,
    "nav toggle has no accessible name — an icon-only button with no sr-only label",
  );
});

check("navigation styling ships, with no animation", () => {
  // Scoped to this theme's own two bundles. An unscoped glob picks up
  // pagefind's shipped UI CSS (which animates) and opengraph.css,
  // neither of which this check is about.
  const css = [...globSync("_site/_css/initial.css"), ...globSync("_site/_css/defer.css")]
    .map((f) => readFileSync(f, "utf8")).join("");
  assert.ok(css.includes("navigation-toggle"), "nav toggle unstyled");
  // Not just present anywhere — the hide/show rule must actually target the
  // real nav id and read the real toggle attribute, or the CSS could pass
  // while styling something disconnected from the markup.
  assert.ok(
    css.includes("#site-nav") && /\[aria-expanded[=~|^$*]*"?true"?\]/.test(css),
    "toggle styling isn't wired to #site-nav via aria-expanded",
  );
  assert.ok(
    !/\banimation\s*:/.test(css.replace(/prefers-reduced-motion[^}]*}/g, "")),
    "an animation property was introduced — the source's motion was rejected",
  );
  // The toggle used to render as a stray left-aligned button UNDER the site
  // name, because it lives in <aside> while the title lives in <header>. The
  // single-column layout puts those two on one row and pushes the toggle right;
  // without this rule it silently falls back to stacking.
  const sticky = /\.rail-sticky\s*\{([^}]*)\}/g;
  const stickyRules = [...css.matchAll(sticky)].map((m) => m[1]);
  assert.ok(
    stickyRules.some((r) => /display:\s*flex/.test(r) && /justify-content:\s*space-between/.test(r)),
    "no .rail-sticky flex row — the mobile toggle will stack under the title instead of aligning right with it",
  );
  assert.ok(
    /\.navigation-toggle-icon\s*\{/.test(css),
    "the hamburger icon has no CSS — the button renders empty",
  );
});

const mf2 = {
  articles: ["h-entry", "p-name", "e-content"],
  notes: ["h-entry", "e-content"],
  bookmarks: ["h-entry", "u-bookmark-of"],
  likes: ["h-entry", "u-like-of"],
  replies: ["h-entry", "u-in-reply-to"],
  photos: ["h-entry", "u-photo"],
};

for (const [type, classes] of Object.entries(mf2)) {
  check(`${type} render their microformats`, () => {
    // One directory deep: post permalinks are /<type>/<slug>/, while
    // /<type>/index.html is that type's listing page (content/
    // collection-index.liquid). `**` would hand this check a listing and
    // then fail it for not looking like a post.
    const files = globSync(`_site/${type}/*/index.html`);
    assert.ok(files.length > 0, `no built page under _site/${type}/`);
    const html = readFileSync(files[0], "utf8");
    for (const c of classes) {
      assert.ok(html.includes(c), `missing ${c}`);
    }

    // IdAttributePlugin (eleventy.config.js) is otherwise untested — nothing
    // else in this suite fails if its registration is deleted. Assert its
    // slugified heading id lands on the real p-name heading it targets.
    if (type === "articles") {
      assert.ok(
        /<h1[^>]+class="p-name[^"]*"[^>]+id="[a-z0-9-]+"/.test(html),
        "article's p-name heading has no id — IdAttributePlugin not applied",
      );
    }
  });
}

check("the archive is an h-feed listing every post", () => {
  // Task 12a: found during Task 12 — the theme built 8 pages and the
  // homepage linked to none of them. This asserts every post type is
  // represented, so a listing that silently drops the titleless types
  // (note/bookmark/like/reply — the majority of Indiekit's post types)
  // fails, not just a listing that shows articles alone.
  const html = readFileSync("_site/archive/index.html", "utf8");
  assert.ok(/class="[^"]*\bh-feed\b/.test(html), "homepage is not marked up as an h-feed");
  for (const type of ["articles", "notes", "bookmarks", "likes", "replies", "photos"]) {
    assert.ok(
      new RegExp(`href="/${type}/[^"]+/"`).test(html),
      `homepage h-feed has no entry linking into /${type}/`,
    );
  }
});

check("archive h-feed entries carry h-entry, not bare links", () => {
  // The check above would also pass if the listing were a plain <a> list
  // with no microformats at all — assert each entry is itself a valid
  // h-entry, one per post-tagged fixture (8: see the feed entry-count
  // check above for why it's 8, not 6).
  const html = readFileSync("_site/archive/index.html", "utf8");
  const entryCount = (html.match(/class="h-entry"/g) || []).length;
  assert.equal(entryCount, 8, `expected 8 h-entry listing entries, found ${entryCount}`);
});

check("archive h-feed lists posts newest first", () => {
  // Would pass trivially if the listing were unordered and happened to
  // match — compare the actual href order against fixture dates sorted
  // descending, not just "some order exists".
  const html = readFileSync("_site/archive/index.html", "utf8");
  const feedSection = html.split(/class="[^"]*\bh-feed\b[^"]*"/)[1] ?? "";
  // Task S4: the photo type's feed row (types/photo.liquid) wraps its
  // thumbnail in a second, plain (unmarked) link back to the same
  // permalink — deliberately not u-url, so a real mf2 parser has only one
  // u-url per entry to resolve (see task-s4-report.md). A bare `href="..."`
  // scan would double-count that entry; anchor on the class every entry's
  // *one* real permalink link always carries instead.
  const hrefs = [...feedSection.matchAll(/<a\s+class="[^"]*\bu-url\b[^"]*"\s+href="(\/(?:articles|notes|bookmarks|likes|replies|photos)\/[^"]+\/)"/g)]
    .map((m) => m[1]);
  assert.equal(hrefs.length, 8, `expected 8 entry links inside the h-feed, found ${hrefs.length}`);

  const fixtures = [
    ["articles", "fixture-article"],
    ["notes", "fixture-note"],
    ["bookmarks", "fixture-bookmark"],
    ["bookmarks", "fixture-untitled-bookmark"],
    ["likes", "fixture-like"],
    ["replies", "fixture-reply"],
    ["photos", "fixture-photo"],
    ["photos", "fixture-gallery"],
  ];
  const byHref = new Map(
    fixtures.map(([type, slug]) => [
      `/${type}/${slug}/`,
      Date.parse(readFileSync(`content/${type}/${slug}.md`, "utf8").match(/^date:\s*["']?([^"'\n]+?)["']?\s*$/m)[1]),
    ]),
  );
  const actualOrder = hrefs.map((href) => byHref.get(href));
  assert.ok(actualOrder.every((d) => Number.isFinite(d)), "a listed href did not match any known fixture");
  const expectedOrder = [...actualOrder].sort((a, b) => b - a);
  assert.deepEqual(actualOrder, expectedOrder, "h-feed entries are not sorted newest-first");
});

check("archive h-feed entry dates match the same instant as the post's own page", () => {
  // The listing reuses the isoInstant/humanDate filters (_11ty/dateResolver.js)
  // via the Task 6 type partials. Those filters re-read the *current* page's
  // own front matter (`this.page.inputPath`) to detect an explicit UTC
  // offset — a naive reuse from within a `{% for post in collections.post %}`
  // loop on the homepage leaves `this.page` bound to content/index.liquid
  // (which has no `date:` line at all), silently mis-detecting every post as
  // zone-less and re-anchoring an already-correct instant by the configured
  // timezone's offset (+2h for Europe/Brussels in August) — a plausible
  // string that is simply wrong. Compare real instants (epoch ms), not
  // string shape, against each fixture's own permalink page.
  const html = readFileSync("_site/archive/index.html", "utf8");
  const fixtures = [
    ["articles", "fixture-article"],
    ["notes", "fixture-note"],
    ["bookmarks", "fixture-bookmark"],
    ["bookmarks", "fixture-untitled-bookmark"],
    ["likes", "fixture-like"],
    ["replies", "fixture-reply"],
    ["photos", "fixture-photo"],
    ["photos", "fixture-gallery"],
  ];
  for (const [type, slug] of fixtures) {
    const pageHtml = readFileSync(`_site/${type}/${slug}/index.html`, "utf8");
    const pageMatch = pageHtml.match(/dt-published" datetime="([^"]*)"/);
    assert.ok(pageMatch, `${type}/${slug}: page has no dt-published datetime attribute`);

    // Extract the row with the nesting-aware helper rather than by splitting
    // on the permalink href. A photo row contains that href TWICE — once on
    // the .posts-link anchor and once on the .posts-thumb anchor — so the old
    // split window was whatever happened to sit between the two, and it
    // silently stopped containing <time> the moment the thumbnail moved ahead
    // of the date. That is a property of the extraction, not of the markup.
    const rows = extractHEntryBlocks(html, "li");
    const entry = rows.find((row) => row.includes(`href="/${type}/${slug}/"`));
    assert.ok(entry, `${type}/${slug}: no h-entry row found in the archive listing`);
    const listingMatch = entry.match(/dt-published" datetime="([^"]*)"/);
    assert.ok(listingMatch, `${type}/${slug}: no dt-published datetime attribute in its h-feed entry`);
    assert.equal(
      Date.parse(listingMatch[1]),
      Date.parse(pageMatch[1]),
      `${type}/${slug}: h-feed entry datetime "${listingMatch[1]}" is not the same instant as the page's "${pageMatch[1]}"`,
    );
  }
});

// Extracts the full source text of every top-level `<TAG class="h-entry">
// ...</TAG>` block from an HTML string, respecting nesting. The four checks
// above are all regex/string matches over flat HTML — none of them can tell
// whether a `u-url` anchor is a property of an h-entry or merely somewhere
// else on the same page (this is exactly how the h-feed permalink bug
// shipped with a green suite: the anchor sat as a sibling *before* each
// <article>, and every flat check still matched). A naive non-greedy scan
// (`/<article[^>]*>.*?<\/article>/gs`) would also mismatch here: nothing in
// this file's markup nests a same-named tag inside itself, but relying on
// that silently is how "a check that matches the wrong span" (this
// project's own stated failure mode) gets written — so this walks
// open/close tags with an explicit depth counter instead of trusting
// non-greedy regex to stop at the right boundary.
//
// tagName defaults to "article" (every permalink page's own layout,
// entry.liquid, wraps its h-entry that way). Task S4 (audit §2.2, corrected)
// moved the homepage listing's h-entry onto the <li> itself, not a nested
// <article> — the source's own `.posts`/`.posts-link` selectors are
// descendant combinators off `li` and a nested <article> would break every
// one of them (see post-list-entry.liquid's own comment) — so the homepage
// checks below pass tagName: "li" instead.
// Remove nested microformat roots from an h-entry block, leaving only the
// properties that belong to the entry itself.
//
// Required by the mf2 parsing spec, not a convenience: "when a child element
// itself has a microformat (h-* or backcompat roots), properties within it are
// added to that nested structure rather than the parent… such a property should
// only be showing up on one of them"
// (microformats.org/wiki/microformats2-parsing).
//
// Concretely: a reply's `u-in-reply-to h-cite` legitimately carries `p-name`
// for the CITED post. A flat regex over the block sees that p-name and
// concludes the titleless entry has a name, which is exactly backwards.
function stripNestedMicroformats(block) {
  const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img",
    "input", "link", "meta", "source", "track", "wbr"]);
  const isRoot = (attrs) => /\bclass="[^"]*\bh-[a-z][a-z0-9-]*\b/.test(`class="${(/class="([^"]*)"/.exec(attrs) || [, ""])[1]}"`);

  let out = block;
  for (let guard = 0; guard < 50; guard++) {
    const tagRe = /<([a-z][a-z0-9-]*)\b([^>]*)>/gi;
    let m, found = null, first = true;
    while ((m = tagRe.exec(out))) {
      if (first) { first = false; continue; } // the block's own root element
      if (VOID.has(m[1].toLowerCase())) continue;
      if (isRoot(m[2])) { found = { tag: m[1], start: m.index, afterOpen: tagRe.lastIndex }; break; }
    }
    if (!found) return out;

    // Walk to the matching close, honouring same-name nesting.
    const nest = new RegExp(`<${found.tag}\\b[^>]*>|</${found.tag}>`, "gi");
    nest.lastIndex = found.afterOpen;
    let depth = 1, end = -1, n;
    while ((n = nest.exec(out))) {
      depth += n[0].startsWith("</") ? -1 : 1;
      if (depth === 0) { end = nest.lastIndex; break; }
    }
    if (end === -1) return out; // unbalanced; leave it rather than mangle
    out = out.slice(0, found.start) + out.slice(end);
  }
  return out;
}

function extractHEntryBlocks(html, tagName = "article") {
  const tagRe = new RegExp(`<${tagName}\\b[^>]*>|</${tagName}>`, "g");
  const blocks = [];
  let openStart = -1;
  let depth = 0;
  let match;
  while ((match = tagRe.exec(html))) {
    const isOpen = match[0].startsWith(`<${tagName}`);
    if (isOpen) {
      if (depth === 0) {
        openStart = match.index;
        // Only h-entry-classed opens are collected — a plain <TAG> with no
        // h-entry class is tracked for depth only, not returned as a block.
      }
      depth++;
    } else {
      depth--;
      if (depth === 0 && openStart !== -1) {
        const block = html.slice(openStart, match.index + match[0].length);
        if (new RegExp(`^<${tagName} class="h-entry"`).test(block)) {
          blocks.push(block);
        }
        openStart = -1;
      }
    }
  }
  return blocks;
}

check("every h-entry in the archive listing carries its own u-url", () => {
  // The bug this guards against: the permalink <a class="u-url"> rendered
  // as a sibling *before* each <article class="h-entry">, not inside it. A
  // real mf2 parser confirmed the consequence — all 8 permalinks collapsed
  // onto the h-feed root's `url` property and every h-entry child had none.
  // Flat regex/string checks (the four `h-feed ...` checks above) cannot
  // see this: they all matched a `u-url` and an `h-entry` existing
  // *somewhere* on the page, never whether one is nested inside the other.
  const html = readFileSync("_site/archive/index.html", "utf8");
  const blocks = extractHEntryBlocks(html, "li");

  // Guards against the "scan matching no files passes forever" false-green
  // pattern: if the extractor's boundary logic were broken and found zero
  // blocks, `blocks.every(...)` below would vacuously pass on an empty
  // array. Pin the count to the known fixture total (see "h-feed entries
  // carry h-entry" above for why it's 8) so a broken extractor fails loudly
  // instead of silently checking nothing.
  assert.equal(blocks.length, 8, `expected 8 h-entry blocks, found ${blocks.length}`);

  const missing = blocks
    .map((block, i) => ({ i, hasUrl: /\bu-url\b/.test(block) }))
    .filter((b) => !b.hasUrl);
  assert.equal(
    missing.length,
    0,
    `${missing.length} of ${blocks.length} h-entry blocks have no u-url within their own boundaries (indices: ${missing.map((m) => m.i).join(", ")})`,
  );
});

check("every post permalink carries tmpl-page and has exactly one <h1>; the homepage has exactly one", () => {
  // Task S3 (audit §2.3–§2.5): entry.liquid set no `tmpl`, so .content-grid,
  // the reading measure, .primary-title's width clamp and the desktop type
  // ramp never applied to a single real post — and <h1 class="p-name"> lived
  // inside types/article.liquid, shared with the feed listing, so five of
  // six permalink types shipped zero <h1> and the homepage shipped two
  // (article's own duplicated into the feed loop). _site/opengraph/** is a
  // separate page set rendered through layouts/opengraph.liquid and
  // legitimately carries neither tmpl-page nor this <h1> convention —
  // excluded by construction below (the per-type globs never reach it),
  // matching the established exemption used elsewhere in this suite.
  const types = ["articles", "notes", "bookmarks", "likes", "replies", "photos"];
  let checkedPages = 0;
  for (const type of types) {
    // One directory deep: post permalinks are /<type>/<slug>/, while
    // /<type>/index.html is that type's listing page (content/
    // collection-index.liquid). `**` would hand this check a listing and
    // then fail it for not looking like a post.
    const files = globSync(`_site/${type}/*/index.html`);
    assert.ok(files.length > 0, `no built page under _site/${type}/ — scan is vacuous`);
    for (const file of files) {
      checkedPages++;
      const html = readFileSync(file, "utf8");
      const h1Count = (html.match(/<h1[\s>]/g) || []).length;
      assert.equal(h1Count, 1, `${file}: expected exactly one <h1>, found ${h1Count}`);
      const htmlTag = html.match(/<html\b[^>]*>/)?.[0] ?? "";
      assert.ok(
        /\bclass="[^"]*\btmpl-page\b/.test(htmlTag),
        `${file}: <html> does not carry tmpl-page (${htmlTag})`,
      );
    }
  }
  assert.ok(checkedPages > 0, "found no post permalink pages to check — scan is vacuous");

  const home = readFileSync("_site/index.html", "utf8");
  const homeH1Count = (home.match(/<h1[\s>]/g) || []).length;
  assert.equal(homeH1Count, 1, `homepage: expected exactly one <h1>, found ${homeH1Count}`);
});

check("every post's content wrapper carries both content-grid and e-content", () => {
  // Task S3 (audit §2.5): the six type partials wrapped their body in
  // <div class="e-content"> alone — content-grid never appeared in built
  // output, so .tmpl-page .content-grid's reading-measure grid never
  // applied to a real post. "like" has no e-content div at all (its body is
  // just a URL — see "heading-anchors wraps..." above) and is excluded
  // here for the same reason, not missed.
  const types = ["articles", "notes", "bookmarks", "replies", "photos"];
  let checkedPages = 0;
  for (const type of types) {
    // One directory deep: post permalinks are /<type>/<slug>/, while
    // /<type>/index.html is that type's listing page (content/
    // collection-index.liquid). `**` would hand this check a listing and
    // then fail it for not looking like a post.
    const files = globSync(`_site/${type}/*/index.html`);
    assert.ok(files.length > 0, `no built page under _site/${type}/ — scan is vacuous`);
    for (const file of files) {
      checkedPages++;
      const html = readFileSync(file, "utf8");
      assert.ok(
        /class="[^"]*\bcontent-grid\b[^"]*\be-content\b[^"]*"/.test(html) ||
          /class="[^"]*\be-content\b[^"]*\bcontent-grid\b[^"]*"/.test(html),
        `${file}: no element carries both content-grid and e-content`,
      );
    }
  }
  assert.ok(checkedPages > 0, "found no pages to check — scan is vacuous");
});

check("p-name marks titled post types only — titleless types must not carry one", () => {
  // Was: "every h-entry still carries a p-name". That invariant was wrong.
  // In mf2 a note is DEFINED by having no explicit p-name — parsers imply the
  // name from content, and consumers compare name vs. content to choose
  // note-vs-article rendering. eleventyComputed.js synthesises a
  // "<Type> · <date>" label purely so the Atom feed's atom:title is non-empty;
  // marking that label up as p-name made all four titleless types parse as
  // titled articles named after their own timestamp, and (via the `truncate`
  // filter, _11ty/webmentionsPlugin.js:56) folded a literal
  // "<span class=tag-inline>Truncated</span>" UI badge INTO the post's name.
  // A photo's p-name was its image's alt text, contradicting the same post's
  // own permalink heading. So the correct invariant is type-dependent:
  //   articles, bookmarks -> real title, MUST carry p-name
  //   notes, likes, replies, photos -> titleless, MUST NOT carry p-name
  // Every h-entry, both kinds, must still carry u-url — that is what makes the
  // entry addressable, and it is the guard the old check was really providing.
  const TITLED = new Set(["articles", "bookmarks"]);

  const rows = extractHEntryBlocks(readFileSync("_site/archive/index.html", "utf8"), "li");
  assert.equal(rows.length, 8, `expected 8 h-entry blocks in the feed, found ${rows.length}`);
  for (const row of rows) {
    const href = /href="\/([a-z]+)\//.exec(row);
    assert.ok(href, `listing row has no typed permalink href: ${row.slice(0, 120)}`);
    assert.ok(/\bu-url\b/.test(row), `listing row for /${href[1]}/ has no u-url`);
    const hasName = /\bp-name\b/.test(stripNestedMicroformats(row));
    if (TITLED.has(href[1])) {
      assert.ok(hasName, `listing row for /${href[1]}/ is a titled type but has no p-name`);
    } else {
      assert.ok(!hasName, `listing row for /${href[1]}/ is titleless but carries p-name`);
    }
  }

  // The badge the truncate filter appends must never land inside a p-name.
  for (const row of rows) {
    const named = [...row.matchAll(/<a[^>]*\bp-name\b[^>]*>([\s\S]*?)<\/a>/g)];
    for (const m of named) {
      assert.ok(
        !/tag-inline/.test(m[1]),
        `a p-name anchor contains the "Truncated" UI badge: ${m[1].slice(0, 80)}`,
      );
    }
  }

  for (const type of ["articles", "notes", "bookmarks", "likes", "replies", "photos"]) {
    // One directory deep: post permalinks are /<type>/<slug>/, while
    // /<type>/index.html is that type's listing page (content/
    // collection-index.liquid). `**` would hand this check a listing and
    // then fail it for not looking like a post.
    const files = globSync(`_site/${type}/*/index.html`);
    assert.ok(files.length > 0, `no built page under _site/${type}/`);
    for (const file of files) {
      const blocks = extractHEntryBlocks(readFileSync(file, "utf8"));
      assert.equal(blocks.length, 1, `${file}: expected exactly one h-entry, found ${blocks.length}`);
      assert.ok(/\bu-url\b/.test(blocks[0]), `${file}: its h-entry has no u-url`);
      // Entry-level only: a nested h-cite's p-name is the CITED work's name.
      const hasName = /\bp-name\b/.test(stripNestedMicroformats(blocks[0]));
      if (TITLED.has(type)) {
        assert.ok(hasName, `${file}: titled type with no p-name`);
      } else {
        assert.ok(!hasName, `${file}: titleless type must not carry p-name`);
      }
    }
  }
});

check("the homepage listing emits .posts/.posts-link/.date and each has a matching rule in compiled CSS", () => {
  // Task S4 (audit §2.2): the reinvented listing (<ol class="h-feed"><li>
  // <article class="h-entry">) matched none of the source's .posts
  // selectors — the CSS existed (once ported) but nothing in the markup
  // wore its classes. Assert both sides: the class in markup AND a rule for
  // it in compiled CSS, scoped to the two bundles a real page links (see
  // PAGE_CSS_GLOB's own comment on why not a bare "_site/_css/**/*.css").
  const html = readFileSync("_site/index.html", "utf8");
  assert.ok(/<ol class="[^"]*\bposts\b[^"]*\bh-feed\b[^"]*"/.test(html), "homepage <ol> does not carry .posts alongside .h-feed");
  assert.ok(/class="[^"]*\bposts-link\b[^"]*"/.test(html), "no element in built output carries .posts-link");
  assert.ok(/<time class="[^"]*\bdate\b[^"]*\bdt-published\b[^"]*"/.test(html), "no <time> carries .date alongside .dt-published");

  const css = globSync(PAGE_CSS_GLOB)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.ok(css.length > 0, `${PAGE_CSS_GLOB} matched no files — check is vacuous`);
  assert.ok(/\.posts\s*\{[^}]*\}/.test(css), "no `.posts { ... }` rule in compiled page CSS");
  assert.ok(/\.posts\s+\.posts-link\s*\{[^}]*\}/.test(css), "no `.posts .posts-link { ... }` rule in compiled page CSS");
  assert.ok(/\.posts\s+\.date\s*\{[^}]*\}/.test(css), "no `.posts .date { ... }` rule in compiled page CSS");
});

check("the archive listing never embeds a full post body — no content-grid/e-content inside any <li>", () => {
  // Task S4, corrected per task-s4-report.md: the first pass at this
  // listing rendered the same content-grid e-content div the permalink page
  // uses into every feed row, making the homepage a wall of repeated post
  // text instead of a compact listing — content-grid is a *permalink*
  // layout class (Task S3), it doesn't belong inside a list item at all.
  // Pin this so it can't come back, for both listing shapes (titled: no
  // body at all; titleless: a compact .description excerpt, never the full
  // e-content wrapper).
  const html = readFileSync("_site/archive/index.html", "utf8");
  const blocks = extractHEntryBlocks(html, "li");
  assert.equal(blocks.length, 8, `expected 8 h-entry <li> blocks, found ${blocks.length}`);
  const withBody = blocks
    .map((block, i) => ({ i, hasBody: /\bcontent-grid\b/.test(block) || /\be-content\b/.test(block) }))
    .filter((b) => b.hasBody);
  assert.equal(
    withBody.length,
    0,
    `${withBody.length} feed <li> blocks embed a full post body (content-grid/e-content) — indices: ${withBody.map((b) => b.i).join(", ")}`,
  );
});

check("a Micropub draft is dropped from pages, the feed and the h-feed in a production build", () => {
  // Task 17. content/notes/fixture-draft-note.md carries `draft: true` (the
  // field @indiekit/preset-eleventy actually writes for a Micropub
  // `post-status: draft` post — see eleventy.config.js's Task 17 comment)
  // and a unique marker string. Checking absence alone would trivially pass
  // if the fixture were ever deleted — the matching "present under serve"
  // check below is what makes that impossible: deleting the fixture fails
  // THAT check, not this one. Together they prove the drop is real, not
  // "nothing to find".
  assert.ok(
    !existsSync("_site/notes/fixture-draft-note/index.html"),
    "draft note built its own page in a production build",
  );
  const feed = readFileSync("_site/feed.xml", "utf8");
  assert.ok(!feed.includes("Half-finished thought"), "draft note's marker leaked into feed.xml");
  const homepage = readFileSync("_site/archive/index.html", "utf8");
  assert.ok(!homepage.includes("Half-finished thought"), "draft note's marker leaked into the h-feed archive listing");
  assert.ok(
    !homepage.includes("/notes/fixture-draft-note/"),
    "draft note has an h-feed entry linking to its (nonexistent) page",
  );
});

await checkAsync("the same Micropub draft is present under serve mode", async () => {
  // The mirror of the check above, driving a real serve-mode build the same
  // way the Task 13/14 "under serve mode, critical CSS is linked" check
  // does (in-process `new Eleventy(..., { runMode: "serve" })` — a later
  // `new Eleventy(...)` call, in this process or a spawned child, resets
  // process.env.ELEVENTY_RUN_MODE regardless of what this leaves behind,
  // per that check's own comment). Proves the preprocessor's
  // ELEVENTY_RUN_MODE === "build" condition actually varies by mode, rather
  // than dropping drafts unconditionally like the port source's un-adapted
  // default (which would leave this check red forever).
  const outDir = "_site-draft-serve-check";
  rmSync(outDir, { recursive: true, force: true });
  try {
    const elev = new Eleventy(undefined, outDir, {
      source: "cli",
      quietMode: true,
      runMode: "serve",
    });
    await elev.write();

    assert.ok(
      existsSync(`${outDir}/notes/fixture-draft-note/index.html`),
      "draft note did not build its own page under serve mode",
    );
    const feed = readFileSync(`${outDir}/feed.xml`, "utf8");
    assert.ok(feed.includes("Half-finished thought"), "draft note's marker is missing from feed.xml under serve mode");
    const homepage = readFileSync(`${outDir}/archive/index.html`, "utf8");
    assert.ok(
      homepage.includes("Half-finished thought"),
      "draft note's marker is missing from the h-feed archive listing under serve mode",
    );
    assert.ok(
      homepage.includes("/notes/fixture-draft-note/"),
      "draft note has no h-feed entry linking to its page under serve mode",
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

check("photo renders a URL, not an object", () => {
  const files = globSync("_site/photos/**/index.html");
  const html = readFileSync(files[0], "utf8");
  assert.ok(!html.includes("[object Object]"), "photo stringified an object");
  assert.ok(
    /\bsrc="\/media\/sample\.png"/.test(html),
    "photo src is not the exact site-absolute URL Indiekit wrote — the image transform likely resolved it against content/ (e.g. src=\"content/media/sample.png\")",
  );
});

check("each post type builds a directory index", () => {
  for (const type of Object.keys(mf2)) {
    const files = globSync(`_site/${type}/*/index.html`);
    assert.ok(files.length > 0, `${type} did not build <slug>/index.html`);
  }
});

check("every page has a skip link targeting main content", () => {
  // Task 18 (§7.4): the skip link is the accessibility floor, not an
  // enhancement — a leak guard that reads only index.html would have missed
  // that entry.liquid (six post types) never carried it at all, exactly the
  // failure mode this project has already recorded once. Glob every built
  // page, not the homepage alone.
  //
  // Task 20: _site/opengraph/** is exempt — those pages render through
  // _includes/layouts/opengraph.liquid, not default.liquid, and are never
  // navigated by a keyboard user (they exist only to be photographed by a
  // screenshot service, noindex/nofollow — see that layout's own comment
  // for why it deliberately skips base.liquid/default.liquid entirely).
  const files = globSync("_site/**/*.html").filter((f) => !f.startsWith("_site/opengraph/"));
  assert.ok(files.length > 0, "no .html produced in _site — this check scanned nothing");
  for (const file of files) {
    const html = readFileSync(file, "utf8");
    assert.ok(/href="#skiplink-content"/.test(html), `no skip link in ${file}`);
    assert.ok(/id="skiplink-content"/.test(html), `no skip link target in ${file}`);
  }
});

check("the skip link is the first element in the body", () => {
  // Not just present anywhere on the page — it has to be reachable by the
  // very first Tab press, which requires it to precede everything else in
  // body content (default.liquid:11).
  //
  // Task 20: same _site/opengraph/** exemption as the check above.
  const files = globSync("_site/**/*.html").filter((f) => !f.startsWith("_site/opengraph/"));
  for (const file of files) {
    const html = readFileSync(file, "utf8");
    const bodyMatch = /<body[^>]*>([\s\S]*)/.exec(html);
    assert.ok(bodyMatch, `no <body> found in ${file}`);
    const afterBody = bodyMatch[1].trimStart();
    assert.ok(
      /^<a href="#skiplink-content"/.test(afterBody),
      `skip link is not the first element in <body> of ${file}`,
    );
  }
});

check("every target=\"_blank\" link carries rel=\"noopener noreferrer\"", () => {
  // Mechanically checkable per §7.4 — a target="_blank" without noopener
  // lets the opened page's window.opener reach back into this one.
  const files = globSync("_site/**/*.html");
  assert.ok(files.length > 0, "no .html produced in _site — this check scanned nothing");
  for (const file of files) {
    const html = readFileSync(file, "utf8");
    // Match each <a ...> tag that carries target="_blank" and assert THAT
    // tag's own attribute string carries rel="noopener noreferrer" — not a
    // bare substring search across the whole file, which would pass if the
    // rel sat on some unrelated tag elsewhere on the page.
    const anchors = html.matchAll(/<a\b[^>]*>/g);
    for (const [tag] of anchors) {
      if (!/target="_blank"/.test(tag)) continue;
      assert.ok(
        /rel="noopener noreferrer"/.test(tag),
        `target="_blank" anchor missing rel="noopener noreferrer" in ${file}: ${tag}`,
      );
    }
  }
});

check("scrollbar-gutter and the img[width][height] reset reach the compiled CSS", () => {
  // Scoped to this theme's own two bundles. An unscoped glob picks up
  // pagefind's shipped UI CSS (which animates) and opengraph.css,
  // neither of which this check is about.
  const css = [...globSync("_site/_css/initial.css"), ...globSync("_site/_css/defer.css")]
    .map((f) => readFileSync(f, "utf8")).join("");
  assert.ok(css.length > 0, "no CSS produced in _site — this check scanned nothing");
  assert.ok(
    /scrollbar-gutter\s*:\s*stable/.test(css),
    "scrollbar-gutter: stable did not reach the compiled CSS",
  );
  assert.ok(
    /img\[width\]\[height\]\s*\{[^}]*height\s*:\s*auto/.test(css),
    "img[width][height] { height: auto } did not reach the compiled CSS",
  );
});

check(".sr-only is a real, visually-hidden rule — not just a class name in markup", () => {
  // This project has eleven recorded defects that passed their tests while
  // being wrong. A check that only greps for the string ".sr-only" in the
  // CSS would pass even if the rule body were empty or unrelated. Assert
  // the compiled rule actually carries the a11y-only clipping technique.
  // Scoped to this theme's own two bundles. An unscoped glob picks up
  // pagefind's shipped UI CSS (which animates) and opengraph.css,
  // neither of which this check is about.
  const css = [...globSync("_site/_css/initial.css"), ...globSync("_site/_css/defer.css")]
    .map((f) => readFileSync(f, "utf8")).join("");
  const rule = /\.sr-only\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, ".sr-only has no compiled CSS rule at all");
  assert.ok(
    /position\s*:\s*absolute/.test(rule[1]) &&
      /width\s*:\s*1px/.test(rule[1]) &&
      /height\s*:\s*1px/.test(rule[1]) &&
      /overflow\s*:\s*hidden/.test(rule[1]),
    `.sr-only rule does not carry the a11y-only clipping technique: ${rule[1]}`,
  );
});

check("speedlify is absent when disabled", () => {
  const html = readFileSync("_site/index.html", "utf8");
  assert.ok(!html.includes("speedlify2-score"), "element rendered while disabled");
});

check("the speedlify badge renders only on pages the configured instance actually measures", () => {
  // The disabled-state check above only proves the widget can be hidden — it
  // would still pass if the whole integration were deleted. Build a throwaway
  // output with speedlify enabled and assert the badge's real contract.
  //
  // That contract is NOT "renders everywhere". The badge fetches its score
  // client-side, so on a page the instance does not measure it paints an empty
  // box; _data/speedlify.js exists to gate it on the instance's own
  // /api/urls.json index. www.speedlify.dev measures 40 URLs, only 11 of them
  // its owner's own pages — the badge is absent from the other ~500 by design.
  // SPEEDLIFY_FIXTURE supplies that index locally so this stays offline and
  // deterministic; the fixture lists the homepage and the article, and nothing
  // else, so both halves of the gate are exercised in one build.
  const sitePath = "_data/site.json";
  const outDir = "_site-speedlify-check";
  const testUrl = "https://speedlify.example/";
  const original = readFileSync(sitePath);

  try {
    const config = JSON.parse(original.toString("utf8"));
    config.speedlify = { url: testUrl, enabled: true };
    writeFileSync(sitePath, JSON.stringify(config, null, 2) + "\n");

    rmSync(outDir, { recursive: true, force: true });
    execFileSync(
      process.execPath,
      ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
      {
        stdio: "pipe",
        env: { ...process.env, SPEEDLIFY_FIXTURE: "test/fixtures/speedlify-urls.json" },
      },
    );

    const tracked = JSON.parse(readFileSync("test/fixtures/speedlify-urls.json", "utf8"));
    const site = JSON.parse(original.toString("utf8"));
    // Map each fixture key back to the built file it corresponds to.
    const pathOf = (absoluteUrl) => absoluteUrl.slice(site.url.length);

    // MEASURED pages: exactly one badge, carrying the configured instance url.
    for (const absoluteUrl of Object.keys(tracked)) {
      const file = `${outDir}${pathOf(absoluteUrl)}index.html`;
      assert.ok(existsSync(file), `fixture lists ${absoluteUrl} but ${file} was not built`);
      const html = readFileSync(file, "utf8");
      assert.ok(
        html.includes(`<speedlify2-score theme="light" speedlify-url="${testUrl}" url="${absoluteUrl}"`),
        `measured page ${absoluteUrl} has no badge, or its url/instance attributes are wrong`,
      );
      // Exactly one. The previous version of this check asserted with
      // includes(), which passes just as happily with two — and there were
      // two: base.liquid carried a copy of the footer's widget, so every page
      // rendered the element twice and fetched the 22KB module twice.
      const widgets = (html.match(/<speedlify2-score\b/g) || []).length;
      assert.equal(widgets, 1, `${file} renders ${widgets} badges, expected exactly 1`);
      const scripts = (html.match(/src="\/js\/speedlify2-score\.js"/g) || []).length;
      assert.equal(scripts, 1, `${file} loads the speedlify module ${scripts} times, expected exactly 1`);
    }

    // UNMEASURED pages: no badge and no module fetch at all. Without this half
    // the gate could be deleted and the check above would still pass.
    const trackedFiles = new Set(
      Object.keys(tracked).map((u) => `${outDir}${pathOf(u)}index.html`),
    );
    const others = globSync(`${outDir}/**/*.html`).filter((f) => !trackedFiles.has(f));
    assert.ok(others.length > 0, "no unmeasured pages to check — the gate is not being exercised");
    for (const file of others) {
      const html = readFileSync(file, "utf8");
      assert.ok(
        !/<speedlify2-score\b/.test(html),
        `${file} is not in the instance's url index but still renders a badge — it would paint an empty box`,
      );
      assert.ok(
        !/src="\/js\/speedlify2-score\.js"/.test(html),
        `${file} loads the speedlify module despite having no badge`,
      );
    }
  } finally {
    writeFileSync(sitePath, original);
    rmSync(outDir, { recursive: true, force: true });
    assert.ok(
      readFileSync(sitePath).equals(original),
      "_data/site.json was not restored to its original bytes",
    );
  }
});

check("builds an Atom feed containing posts", () => {
  assert.ok(existsSync("_site/feed.xml"), "_site/feed.xml missing");
  const xml = readFileSync("_site/feed.xml", "utf8");
  assert.ok(xml.includes("<entry"), "feed contains no entries");
});

check("feed contains every post-tagged fixture, not just any entry", () => {
  // A bare `includes("<entry")` above would also pass if only one post type
  // made it into the feed, or if the collection name were wrong and picked up
  // some unrelated single page. Confirm all 6 post-type fixtures are present,
  // proving the `post` collection tag from Task 6's cascades actually feeds
  // this plugin's `collection.name: "post"` option. 8, not 6: Task 11 added a
  // second bookmark fixture (fixture-untitled-bookmark.md) to exercise the
  // titleless-bookmark fallback.
  const xml = readFileSync("_site/feed.xml", "utf8");
  const entryCount = (xml.match(/<entry>/g) || []).length;
  assert.equal(entryCount, 8, `expected 8 feed entries (one per post-type fixture, plus the untitled-bookmark fixture), got ${entryCount}`);
  for (const type of ["articles", "notes", "bookmarks", "likes", "replies", "photos"]) {
    assert.ok(
      xml.includes(`http://localhost:8080/${type}/`),
      `feed missing an entry linking into /${type}/`,
    );
  }
});

check("feed metadata comes from site.json, not the plugin's placeholder or a hardcoded copy", () => {
  // Prior to this fix, eleventy.config.js passed no `subtitle` (so
  // eleventy-plugin-rss's own lorem-ipsum default shipped verbatim) and
  // hardcoded `title`/`base` as string literals duplicating site.json — a
  // regression in either would previously reach a green suite because
  // nothing asserted feed metadata at all.
  const site = JSON.parse(readFileSync("_data/site.json", "utf8"));
  const xml = readFileSync("_site/feed.xml", "utf8");

  assert.ok(
    !xml.includes("This is a longer description about your blog."),
    "feed subtitle is eleventy-plugin-rss's placeholder lorem, not site.json's description",
  );
  assert.ok(
    xml.includes(`<subtitle>${site.description}</subtitle>`),
    "feed subtitle does not match _data/site.json's description",
  );
  assert.ok(
    xml.includes(`<title>${site.name}</title>`),
    "feed title does not match _data/site.json's name",
  );
  // site.json's url has no trailing slash; the feed's `base` needs one.
  assert.ok(
    xml.includes(`<id>${site.url}/</id>`),
    "feed base does not match site.json's url (with the required trailing slash)",
  );
});

check("every feed entry has a non-empty title", () => {
  // Atom requires atom:title on every entry. Notes, photos, likes and
  // replies carry no `title` front matter (titleless by IndieWeb design),
  // and the plugin renders `post.data.title` verbatim — an unhandled
  // fallback ships as literal <title></title>, which most feed readers
  // render as a blank row. This is the majority case: 4 of the 6 post
  // types produce no title of their own. 8, not 6: see the entry-count
  // check above.
  const xml = readFileSync("_site/feed.xml", "utf8");
  const titles = [...xml.matchAll(/<title>([\s\S]*?)<\/title>/g)]
    .map((m) => m[1].trim())
    // the feed's own <title> (site name) is not an entry title
    .slice(1);
  assert.equal(titles.length, 8, `expected 8 entry titles, found ${titles.length}`);
  for (const title of titles) {
    assert.ok(title.length > 0, "a feed entry has an empty <title>");
  }
});

check("titleless bookmark falls back to its bookmarked URL, not the synthetic date label", () => {
  // eleventyComputed.js's synthetic "<Type> · <date>" fallback used to apply
  // to every titleless postType, including bookmark — even though
  // bookmark.liquid already has a better fallback of its own
  // (`{{ title | default: bookmarkOf }}`, the bookmarked URL). No fixture
  // exercised a titleless bookmark before this check, so the worse label won
  // silently. Assert both the entry page and the feed use the URL.
  const bookmarkUrl = "https://example.com/untitled-bookmark-fixture";

  const html = readFileSync("_site/bookmarks/fixture-untitled-bookmark/index.html", "utf8");
  assert.ok(
    html.includes(`>${bookmarkUrl}<`),
    "bookmark page does not show the bookmarked URL as its link text",
  );
  assert.ok(
    !/Bookmark\s*(&#183;|·)/.test(html),
    "bookmark page still carries the synthetic '<Type> · <date>' label",
  );

  const xml = readFileSync("_site/feed.xml", "utf8");
  assert.ok(
    xml.includes(`<title>${bookmarkUrl}</title>`),
    "feed entry for the titleless bookmark does not use the bookmarked URL as its title",
  );
});

check("feed and page timestamps round-trip to the exact source instant, not just a similar-looking string", () => {
  // Task 11's addDateParsing regression shifted the feed's <updated> by the
  // configured timezone's offset while still producing a plausible-looking
  // ISO string — a string-shape assertion would pass on both the correct
  // and the shifted output. Compare actual instants (epoch ms via
  // Date.parse) against each fixture's own front-matter date instead, and
  // cross-check the page and the feed against each other: the regression
  // left the feed wrong and the page wrong by a *different* amount (two
  // independent code paths), and nothing noticed they disagreed.
  const fixtures = [
    ["articles", "fixture-article"],
    ["notes", "fixture-note"],
    ["bookmarks", "fixture-bookmark"],
    ["bookmarks", "fixture-untitled-bookmark"],
    ["likes", "fixture-like"],
    ["replies", "fixture-reply"],
    ["photos", "fixture-photo"],
    ["photos", "fixture-gallery"],
  ];

  const xml = readFileSync("_site/feed.xml", "utf8");

  for (const [type, slug] of fixtures) {
    const source = readFileSync(`content/${type}/${slug}.md`, "utf8");
    const dateMatch = source.match(/^date:\s*["']?([^"'\n]+?)["']?\s*$/m);
    assert.ok(dateMatch, `content/${type}/${slug}.md has no date: front matter to compare against`);
    const sourceEpoch = Date.parse(dateMatch[1]);
    assert.ok(Number.isFinite(sourceEpoch), `content/${type}/${slug}.md's date: is not parseable`);

    const html = readFileSync(`_site/${type}/${slug}/index.html`, "utf8");
    const pageMatch = html.match(/dt-published" datetime="([^"]*)"/);
    assert.ok(pageMatch, `${type}/${slug}: page has no dt-published datetime attribute`);
    const pageEpoch = Date.parse(pageMatch[1]);
    assert.equal(
      pageEpoch,
      sourceEpoch,
      `${type}/${slug}: page datetime "${pageMatch[1]}" is not the same instant as source date "${dateMatch[1]}"`,
    );

    const entryXml = xml.split("<entry>").find((e) => e.includes(`/${type}/${slug}/`));
    assert.ok(entryXml, `${type}/${slug}: no feed entry found`);
    const feedMatch = entryXml.match(/<updated>([^<]+)<\/updated>/);
    assert.ok(feedMatch, `${type}/${slug}: feed entry has no <updated>`);
    const feedEpoch = Date.parse(feedMatch[1]);
    assert.equal(
      feedEpoch,
      sourceEpoch,
      `${type}/${slug}: feed <updated> "${feedMatch[1]}" is not the same instant as source date "${dateMatch[1]}"`,
    );

    assert.equal(
      pageEpoch,
      feedEpoch,
      `${type}/${slug}: page datetime "${pageMatch[1]}" and feed <updated> "${feedMatch[1]}" disagree`,
    );
  }
});

check("a near-midnight offset date lands on the author's real calendar day, not a naive UTC/local shift", () => {
  // Brussels is UTC+2 in August. 2026-08-31T02:30:00+02:00 is chosen so the
  // *broken* addDateParsing Date branch (keepLocalTime re-anchoring an
  // already-unambiguous instant) doesn't just land 2 hours off — it crosses
  // a calendar day boundary entirely: the true instant is
  // 2026-08-31T00:30:00Z, but the pre-fix code produced
  // 2026-08-30T22:30:00Z (verified by temporarily reverting the fix). A
  // fixture further from midnight would have let a broken implementation
  // pass this check by accident.
  const fixturePath = "content/notes/fixture-note.md";
  const outDir = "_site-midnight-check";
  const original = readFileSync(fixturePath, "utf8");
  assert.ok(/^date: /m.test(original), "fixture-note.md has no `date:` front-matter line to patch");
  const patched = original.replace(/^date: .*$/m, "date: 2026-08-31T02:30:00+02:00");

  writeFileSync(fixturePath, patched);
  try {
    rmSync(outDir, { recursive: true, force: true });
    execFileSync(
      process.execPath,
      ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
      { stdio: "pipe" },
    );

    const expectedInstant = "2026-08-31T00:30:00Z";

    const html = readFileSync(`${outDir}/notes/fixture-note/index.html`, "utf8");
    const pageMatch = html.match(/dt-published" datetime="([^"]*)"/);
    assert.ok(pageMatch, "page has no dt-published datetime attribute");
    assert.equal(
      Date.parse(pageMatch[1]),
      Date.parse(expectedInstant),
      `page datetime "${pageMatch[1]}" is not the true instant ${expectedInstant}`,
    );
    assert.ok(
      html.includes("31 August 2026"),
      `page human-readable date is not the author's local day (31 August 2026): ${html.match(/dt-published"[^>]*>([^<]*)</)?.[1]}`,
    );

    const xml = readFileSync(`${outDir}/feed.xml`, "utf8");
    const entryXml = xml.split("<entry>").find((e) => e.includes("/notes/fixture-note/"));
    assert.ok(entryXml, "feed has no entry for /notes/fixture-note/");
    const feedMatch = entryXml.match(/<updated>([^<]+)<\/updated>/);
    assert.ok(feedMatch, "feed entry has no <updated>");
    assert.equal(
      Date.parse(feedMatch[1]),
      Date.parse(expectedInstant),
      `feed <updated> "${feedMatch[1]}" is not the true instant ${expectedInstant}`,
    );

    assert.equal(
      Date.parse(pageMatch[1]),
      Date.parse(feedMatch[1]),
      `page datetime "${pageMatch[1]}" and feed <updated> "${feedMatch[1]}" disagree`,
    );
  } finally {
    writeFileSync(fixturePath, original);
    rmSync(outDir, { recursive: true, force: true });
    assert.equal(
      readFileSync(fixturePath, "utf8"),
      original,
      "content/notes/fixture-note.md was not restored to its original contents",
    );
  }
});

check("human-readable date text is anchored to site.json's timezone, not the build process's TZ", () => {
  // isoInstant (the machine-readable dt-published attribute) was fixed to
  // ignore the build process's ambient TZ and anchor to site.json's
  // configured timezone via Luxon. The visible text next to it
  // (`{{ date | date: "%-d %B %Y" }}`, now `{{ date | humanDate }}`) had the
  // identical defect: LiquidJS's `date` filter reads the JS Date's fields in
  // the process's *local* timezone, so the same content renders a different
  // calendar day depending on where it's built — CI (UTC) vs a Brussels
  // laptop, say. Build the same content twice, under two TZs chosen so a
  // naive process-local render *would* disagree (23:30 UTC on 2026-08-30 is
  // already 2026-08-31 in Brussels — the site's configured zone — but still
  // 2026-08-30 elsewhere), and assert the rendered day is identical and
  // matches the configured zone regardless of which TZ built it.
  const fixturePath = "content/notes/fixture-note.md";
  const original = readFileSync(fixturePath, "utf8");
  assert.ok(/^date: /m.test(original), "fixture-note.md has no `date:` front-matter line to patch");
  const patched = original.replace(/^date: .*$/m, "date: 2026-08-30T23:30:00.000Z");

  const expectedHuman = "31 August 2026"; // 2026-08-30T23:30:00Z is 2026-08-31 01:30 in Europe/Brussels
  const zones = [
    ["_site-tz-check-brussels", "Europe/Brussels"],
    ["_site-tz-check-chicago", "America/Chicago"],
  ];
  const rendered = {};

  writeFileSync(fixturePath, patched);
  try {
    for (const [outDir, tz] of zones) {
      rmSync(outDir, { recursive: true, force: true });
      execFileSync(
        process.execPath,
        ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
        { stdio: "pipe", env: { ...process.env, TZ: tz } },
      );

      const html = readFileSync(`${outDir}/notes/fixture-note/index.html`, "utf8");
      const match = html.match(/dt-published"[^>]*>([^<]*)</);
      assert.ok(match, `${outDir} (TZ=${tz}): page has no dt-published text content`);
      rendered[tz] = match[1];
    }

    for (const [outDir, tz] of zones) {
      assert.equal(
        rendered[tz],
        expectedHuman,
        `TZ=${tz} rendered "${rendered[tz]}", expected "${expectedHuman}" (site.json's Europe/Brussels)`,
      );
    }
    assert.equal(
      rendered["Europe/Brussels"],
      rendered["America/Chicago"],
      `human date depends on the build's TZ: Europe/Brussels got "${rendered["Europe/Brussels"]}", America/Chicago got "${rendered["America/Chicago"]}"`,
    );
  } finally {
    writeFileSync(fixturePath, original);
    for (const [outDir] of zones) {
      rmSync(outDir, { recursive: true, force: true });
    }
    assert.equal(
      readFileSync(fixturePath, "utf8"),
      original,
      "content/notes/fixture-note.md was not restored to its original contents",
    );
  }
});

check("a zone-less date resolves to the same instant on the page and in the feed, not a naive UTC-midnight reading", () => {
  // Task 11's addDateParsing fix (Date branch, keepLocalTime) was never
  // exercised by isoInstant/humanDate — those filters had their own Date
  // branch that unconditionally treated any Date as an already-correct UTC
  // instant, with no explicit-offset detection at all. Every existing
  // fixture carries an explicit Z, so that divergence had zero coverage:
  // page and feed could (and did) disagree on the very instant they both
  // describe. 2026-08-30 (bare, no zone) is a wall-clock reading in
  // site.json's Europe/Brussels (UTC+2 in August): the true instant is
  // 2026-08-29T22:00:00Z. The unfixed filters instead stamped
  // 2026-08-30T00:00:00Z (trusting YAML's UTC-midnight read verbatim) while
  // addDateParsing correctly produced 2026-08-29T22:00:00Z — the feed
  // reporting the previous day relative to the page.
  const fixturePath = "content/notes/fixture-note.md";
  const outDir = "_site-zoneless-check";
  const original = readFileSync(fixturePath, "utf8");
  assert.ok(/^date: /m.test(original), "fixture-note.md has no `date:` front-matter line to patch");
  const patched = original.replace(/^date: .*$/m, "date: 2026-08-30");

  writeFileSync(fixturePath, patched);
  try {
    rmSync(outDir, { recursive: true, force: true });
    execFileSync(
      process.execPath,
      ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
      { stdio: "pipe" },
    );

    const expectedInstant = "2026-08-29T22:00:00Z";

    const html = readFileSync(`${outDir}/notes/fixture-note/index.html`, "utf8");
    const pageMatch = html.match(/dt-published" datetime="([^"]*)"/);
    assert.ok(pageMatch, "page has no dt-published datetime attribute");
    assert.equal(
      Date.parse(pageMatch[1]),
      Date.parse(expectedInstant),
      `page datetime "${pageMatch[1]}" is not the wall-clock instant ${expectedInstant} — isoInstant is not applying the same zone-anchoring as addDateParsing`,
    );

    const xml = readFileSync(`${outDir}/feed.xml`, "utf8");
    const entryXml = xml.split("<entry>").find((e) => e.includes("/notes/fixture-note/"));
    assert.ok(entryXml, "feed has no entry for /notes/fixture-note/");
    const feedMatch = entryXml.match(/<updated>([^<]+)<\/updated>/);
    assert.ok(feedMatch, "feed entry has no <updated>");
    assert.equal(
      Date.parse(feedMatch[1]),
      Date.parse(expectedInstant),
      `feed <updated> "${feedMatch[1]}" is not the wall-clock instant ${expectedInstant}`,
    );

    assert.equal(
      pageMatch[1],
      feedMatch[1],
      `page datetime "${pageMatch[1]}" and feed <updated> "${feedMatch[1]}" disagree on a zone-less date`,
    );
  } finally {
    writeFileSync(fixturePath, original);
    rmSync(outDir, { recursive: true, force: true });
    assert.equal(
      readFileSync(fixturePath, "utf8"),
      original,
      "content/notes/fixture-note.md was not restored to its original contents",
    );
  }
});

check("offset detection recognises YAML-legal forms beyond strict T...Z", () => {
  // hasExplicitOffset (_11ty/dateResolver.js) used to be
  // /T.*(?:Z|[+-]\d{2}:?\d{2})$/ — it requires a literal T immediately
  // before the time, so it missed three forms js-yaml's own timestamp
  // parser accepts and parses *correctly* into the true UTC instant: a
  // space instead of T, a space before the offset, and a two-digit offset
  // with no minutes part. Missing the offset makes resolveDate() treat an
  // already-unambiguous instant as zone-less and re-anchor it via
  // keepLocalTime — the exact regression this task's earlier commits fixed
  // for strict T...Z forms, reappearing for these three.
  //
  // Expected instants below are computed by hand, not derived from any
  // shared regex, so this check can't inherit the bug it's testing for.
  const forms = [
    ["2026-08-30 10:00:00Z", "2026-08-30T10:00:00Z"],
    ["2026-08-30 10:00:00 +02:00", "2026-08-30T08:00:00Z"],
    ["2026-08-30 10:00:00 +02", "2026-08-30T08:00:00Z"],
  ];

  const fixturePath = "content/notes/fixture-note.md";
  const outDir = "_site-offset-form-check";
  const original = readFileSync(fixturePath, "utf8");
  assert.ok(/^date: /m.test(original), "fixture-note.md has no `date:` front-matter line to patch");

  try {
    for (const [rawDate, expectedInstant] of forms) {
      writeFileSync(fixturePath, original.replace(/^date: .*$/m, `date: ${rawDate}`));
      rmSync(outDir, { recursive: true, force: true });
      execFileSync(
        process.execPath,
        ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
        { stdio: "pipe" },
      );

      const html = readFileSync(`${outDir}/notes/fixture-note/index.html`, "utf8");
      const pageMatch = html.match(/dt-published" datetime="([^"]*)"/);
      assert.ok(pageMatch, `"${rawDate}": page has no dt-published datetime attribute`);
      assert.equal(
        Date.parse(pageMatch[1]),
        Date.parse(expectedInstant),
        `"${rawDate}": page datetime "${pageMatch[1]}" is not ${expectedInstant} — offset was not detected, keepLocalTime re-anchored it`,
      );

      const xml = readFileSync(`${outDir}/feed.xml`, "utf8");
      const entryXml = xml.split("<entry>").find((e) => e.includes("/notes/fixture-note/"));
      assert.ok(entryXml, `"${rawDate}": feed has no entry for /notes/fixture-note/`);
      const feedMatch = entryXml.match(/<updated>([^<]+)<\/updated>/);
      assert.ok(feedMatch, `"${rawDate}": feed entry has no <updated>`);
      assert.equal(
        Date.parse(feedMatch[1]),
        Date.parse(expectedInstant),
        `"${rawDate}": feed <updated> "${feedMatch[1]}" is not ${expectedInstant} — offset was not detected, keepLocalTime re-anchored it`,
      );
    }
  } finally {
    writeFileSync(fixturePath, original);
    rmSync(outDir, { recursive: true, force: true });
    assert.equal(
      readFileSync(fixturePath, "utf8"),
      original,
      "content/notes/fixture-note.md was not restored to its original contents",
    );
  }
});

check("synthetic post-type title label is anchored to site.json's timezone, not the build process's TZ", () => {
  // _data/eleventyComputed.js's title() fallback used to build the
  // "<Type> · <date>" label with `new Date(data.date).toLocaleDateString(
  // "en-GB", …)` — process-local, the same host-dependence Task 11 fixed for
  // the visible dt-published text (humanDate). Build the same content twice
  // under two TZs chosen so a naive process-local render *would* disagree
  // (23:30 UTC on 2026-08-30 is already 2026-08-31 in Brussels — the site's
  // configured zone — but still 2026-08-30 elsewhere), and assert the
  // rendered day is identical and matches the configured zone regardless of
  // which TZ built it.
  const fixturePath = "content/likes/fixture-like.md";
  const original = readFileSync(fixturePath, "utf8");
  assert.ok(/^date: /m.test(original), "fixture-like.md has no `date:` front-matter line to patch");
  const patched = original.replace(/^date: .*$/m, "date: 2026-08-30T23:30:00.000Z");

  const expectedTitle = "Like · 31 Aug 2026"; // 2026-08-30T23:30:00Z is 2026-08-31 01:30 in Europe/Brussels
  const zones = [
    ["_site-tz-title-check-brussels", "Europe/Brussels"],
    ["_site-tz-title-check-chicago", "America/Chicago"],
  ];
  const rendered = {};

  writeFileSync(fixturePath, patched);
  try {
    for (const [outDir, tz] of zones) {
      rmSync(outDir, { recursive: true, force: true });
      execFileSync(
        process.execPath,
        ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
        { stdio: "pipe", env: { ...process.env, TZ: tz } },
      );

      const html = readFileSync(`${outDir}/likes/fixture-like/index.html`, "utf8");
      const match = html.match(/<title>([^<]*)—/);
      assert.ok(match, `${outDir} (TZ=${tz}): page has no <title> to check`);
      rendered[tz] = match[1];
    }

    for (const [outDir, tz] of zones) {
      assert.equal(
        rendered[tz],
        expectedTitle,
        `TZ=${tz} rendered "${rendered[tz]}", expected "${expectedTitle}" (site.json's Europe/Brussels)`,
      );
    }
    assert.equal(
      rendered["Europe/Brussels"],
      rendered["America/Chicago"],
      `synthetic title label depends on the build's TZ: Europe/Brussels got "${rendered["Europe/Brussels"]}", America/Chicago got "${rendered["America/Chicago"]}"`,
    );
  } finally {
    writeFileSync(fixturePath, original);
    for (const [outDir] of zones) {
      rmSync(outDir, { recursive: true, force: true });
    }
    assert.equal(
      readFileSync(fixturePath, "utf8"),
      original,
      "content/likes/fixture-like.md was not restored to its original contents",
    );
  }
});

check("a bookmark with neither title nor bookmarkOf falls back to the synthetic label, not an empty title", () => {
  // eleventyComputed.js's bookmark branch returned data.bookmarkOf
  // unconditionally, restoring `undefined` — and so an empty
  // <title></title> in the Atom feed, the exact bug this task's title
  // fallback exists to prevent — for a bookmark fixture that sets neither
  // `title` nor `bookmarkOf`. No existing fixture exercises that
  // combination.
  const fixturePath = "content/bookmarks/_probe-titleless-bookmark.md";
  const outDir = "_site-titleless-bookmark-check";
  const fixture = `---
eleventyExcludeFromCollections: true
date: 2026-08-30T10:00:00.000Z
---

MARKER_titleless_bookmark
`;

  writeFileSync(fixturePath, fixture);
  try {
    rmSync(outDir, { recursive: true, force: true });
    execFileSync(
      process.execPath,
      ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
      { stdio: "pipe" },
    );

    const outFile = `${outDir}/bookmarks/_probe-titleless-bookmark/index.html`;
    assert.ok(existsSync(outFile), `${outFile} was not built`);
    const html = readFileSync(outFile, "utf8");
    assert.ok(
      html.includes("<title>Bookmark · 30 Aug 2026—"),
      `expected the synthetic label in <title>, got: ${html.match(/<title>[^<]*<\/title>/)?.[0]}`,
    );
  } finally {
    rmSync(fixturePath, { force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

await checkAsync(
  "addDateParsing's fallback branch reads a literal `published:` field, not file birthtime",
  async () => {
    // Indiekit filenames are slug-based, so the addDateParsing fallback
    // branch (eleventy.config.js) can't derive a date from a YYYY-MM-DD
    // filename prefix the way the port source does — it reads a literal
    // `published:` key from the file's own front matter instead.
    //
    // This has to be checked through the Atom feed, not the entry page's own
    // HTML: page templates (e.g. _includes/types/note.liquid) read the bare
    // `date` variable, which is the data cascade's *raw* front-matter value
    // — Eleventy never copies addDateParsing's resolved value back onto it,
    // only onto `page.date`. @11ty/eleventy-plugin-rss is what actually
    // reads `page.date` (via the collection item), so it is the one place
    // in this theme where addDateParsing's output is observable at all.
    //
    // A page with neither `date` nor a filename date falls through
    // Eleventy's own defaults to the file's on-disk birthtime (today,
    // whatever day this test happens to run) — asserting on an unambiguous
    // date from another year is what makes a missing/broken implementation
    // provably wrong regardless of the machine's clock. (A near-midnight
    // *offset* value on an existing `date`-bearing fixture would not prove
    // anything here: Eleventy's own default ISO parsing already respects an
    // explicit offset and lands on the correct instant with no
    // addDateParsing at all — see the task report for why.)
    const fixturePath = "content/notes/fixture-note.md";
    const outDir = "_site-date-parsing-check";
    const original = readFileSync(fixturePath, "utf8");
    assert.ok(/^date: /m.test(original), "fixture-note.md has no `date:` front-matter line to patch");
    const patched = original.replace(/^date: .*$/m, 'published: "2024-03-15T14:00:00+01:00"');

    writeFileSync(fixturePath, patched);
    try {
      rmSync(outDir, { recursive: true, force: true });
      execFileSync(
        process.execPath,
        ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
        { stdio: "pipe" },
      );

      const xml = readFileSync(`${outDir}/feed.xml`, "utf8");
      const entry = xml.split("<entry>").find((e) => e.includes("/notes/fixture-note/"));
      assert.ok(entry, "feed has no entry for /notes/fixture-note/");
      // 2024-03-15T14:00:00+01:00 is 2024-03-15T13:00:00Z (Brussels is CET,
      // +01:00, in mid-March — DST hasn't started yet).
      assert.ok(
        entry.includes("2024-03-15T13:00:00"),
        `expected the fallback published date (2024-03-15T14:00+01:00 = 13:00 UTC) in the feed entry, got: ${entry}`,
      );
    } finally {
      writeFileSync(fixturePath, original);
      rmSync(outDir, { recursive: true, force: true });
      assert.equal(
        readFileSync(fixturePath, "utf8"),
        original,
        "content/notes/fixture-note.md was not restored to its original contents",
      );
    }
  },
);

let skipped = 0;
const skip = (name, reason) => {
  skipped++;
  console.log(`skip ${name} — ${reason}`);
};

// These two checks need real fixture data (test/fixtures/webmentions.json)
// fed in via WEBMENTIONS_FIXTURE. On a fresh clone with no env vars set,
// _data/webmentions.js correctly returns no mentions (no token, no network
// call) — skip rather than fail, so a fresh clone still reports a clean run.
if (process.env.WEBMENTIONS_FIXTURE) {
  check("listing rows show webmention-driven social counts", () => {
    // The like/boost/reply counts are the portable half of the source's
    // post-popularity-social-tags.html; its view counts and popularity ranking
    // read from analytics this theme deliberately carries none of. The fixture
    // supplies three in-reply-to mentions for one post and none for the others,
    // so this exercises both the rendered and the absent case in one build.
    const rows = extractHEntryBlocks(readFileSync("_site/archive/index.html", "utf8"), "li");
    const noteRow = rows.find((r) => r.includes('href="/notes/fixture-note/"'));
    assert.ok(noteRow, "no listing row for the webmentioned fixture note");
    assert.match(
      noteRow,
      /<span class="tag-social--reply" title="3 replies">/,
      "the webmentioned post's row shows no reply count",
    );
    // A count only renders when non-zero — a fresh site with no webmentions
    // must not show a row of zeros.
    const quiet = rows.filter((r) => !r.includes('href="/notes/fixture-note/"'));
    assert.ok(quiet.length > 0, "no un-webmentioned rows to check");
    for (const row of quiet) {
      assert.ok(
        !/tag-social/.test(row),
        "a post with no webmentions still renders a social-counts pill",
      );
    }
  });

  check("webmentions render from fixture data", () => {
    const files = globSync("_site/notes/*/index.html");
    const html = readFileSync(files[0], "utf8");
    assert.ok(
      html.includes("WEBMENTION_FIXTURE_MARKER"),
      "fixture webmention not rendered on the note page",
    );

    // Not just present anywhere on the page — a stray dump of the fixture data
    // would also satisfy a bare `includes()`. Confirm the marker rendered
    // through the real mf2 comment markup (u-comment h-cite / p-content), i.e.
    // that it came from the webmentionsForUrl filter -> webmentionlist.liquid
    // -> webmention.liquid pipeline, not some other path.
    const commentEntry = /<li class="static-comments-reply u-comment h-cite"[^>]*>[\s\S]*?<\/li>/.exec(html);
    assert.ok(commentEntry, "no u-comment h-cite webmention entry found on the page");
    assert.ok(
      commentEntry[0].includes("WEBMENTION_FIXTURE_MARKER"),
      "fixture marker did not render inside the webmention comment entry",
    );
    assert.ok(
      commentEntry[0].includes('class="static-comments-msg p-content'),
      "fixture marker rendered outside the p-content comment body",
    );
  });

  check("truncate filter preserves long comments past the built-in 50-char default", () => {
    const files = globSync("_site/notes/*/index.html");
    const html = readFileSync(files[0], "utf8");

    // The fixture's second comment is 129 chars; its tail marker starts at
    // index 109, well past LiquidJS's built-in `truncate` default of 50 —
    // the exact bug that shipped when this theme never registered its own
    // `truncate` filter. Asserting on the tail marker (not the marker used by
    // the check above, which is only 25 chars and inside the first 50) is
    // what makes this catch that regression instead of passing either way.
    const entries = [...html.matchAll(/<li class="static-comments-reply u-comment h-cite"[^>]*>[\s\S]*?<\/li>/g)];
    const survived = entries.some(
      (m) => m[0].includes('class="static-comments-msg p-content') && m[0].includes("TRUNCATE_TAIL_MARKER"),
    );
    assert.ok(
      survived,
      "long fixture comment's tail marker did not survive — truncate silently fell back to LiquidJS's built-in 50-char default",
    );
  });
  check(
    "avatar alt attribute escapes hostile webmention urls",
    () => {
      // indieAvatarBare falls back to the RAW url string when new URL() throws,
      // and that string lands in alt="IndieWeb Avatar for ${url}". The fixture
      // carries an invalid url containing a quote + onload=, so an unescaped
      // build breaks out of the attribute and ships an event handler.
      const html = readFileSync("_site/notes/fixture-note/index.html", "utf8");
      assert.ok(
        html.includes("XSS_BREAKOUT_MARKER"),
        "hostile fixture mention did not render — the check is not exercising the sink",
      );
      assert.ok(
        !/onload="XSS_BREAKOUT_MARKER/.test(html),
        "hostile webmention url broke out of the alt attribute — avatar alt is unescaped",
      );
    },
  );

} else {
  skip(
    "webmentions render from fixture data",
    "WEBMENTIONS_FIXTURE not set",
  );
  skip(
    "avatar alt attribute escapes hostile webmention urls",
    "WEBMENTIONS_FIXTURE not set",
  );
  skip(
    "truncate filter preserves long comments past the built-in 50-char default",
    "WEBMENTIONS_FIXTURE not set",
  );
}

// Task 16 (§2.3 of the best-practices doc / port source imagePlugin.js:19,150-175).
// Placed last: both checks below wipe and rebuild the real _site (and, for the
// durability check, the real .cache/) to exercise the actual contract rather
// than a throwaway stand-in. Every earlier check that reads _site/ has already
// run and recorded its result by the time these mutate it.

await checkAsync(
  "transformOnRequest defers image work to request time under serve mode",
  async () => {
    // eleventy-img's own eleventyImageTransformPlugin defaults
    // `transformOnRequest: process.env.ELEVENTY_RUN_MODE === "serve"` internally
    // (@11ty/eleventy-img/src/transform-plugin.js:146) — our imagePlugin.js
    // never sets this option on the plugin itself, because the library already
    // gates on the same run-mode idiom used everywhere else in this project
    // (imagePlugin.js:19 sets it explicitly only for the separate `imageFactory`
    // helper behind the `getUrlForImage` shortcode). When true, the plugin also
    // wires in `imageOnRequestDuringServePlugin` (transform-plugin.js:149-151),
    // which serves images from a `/.11ty/image/?src=...` route instead of
    // writing files at build/write time — confirmed by reading both files.
    //
    // As with the run-mode probe above, `new Eleventy(..., { runMode: "serve" })`
    // is the only way to reach real serve-mode behaviour without starting a dev
    // server (forbidden here). Unlike that probe, contaminating this process's
    // `process.env.ELEVENTY_RUN_MODE` is NOT a hazard for checks that run later:
    // Eleventy sets `this.runMode = options.runMode || "build"` purely from the
    // options passed to its own constructor (CoreMinimal.js:152) — it never
    // reads back the ambient env to decide its own mode — so every later
    // `new Eleventy(...)` call, in this process or a spawned child, resets
    // ELEVENTY_RUN_MODE correctly regardless of what a prior build left behind.
    const buildOutDir = "_site-image-transform-build-check";
    const serveOutDir = "_site-image-transform-serve-check";
    rmSync(buildOutDir, { recursive: true, force: true });
    rmSync(serveOutDir, { recursive: true, force: true });
    try {
      const build = new Eleventy(undefined, buildOutDir, { source: "cli", quietMode: true });
      await build.write();

      const serve = new Eleventy(undefined, serveOutDir, {
        source: "cli",
        quietMode: true,
        runMode: "serve",
      });
      await serve.write();

      const buildBuilt = globSync(`${buildOutDir}/img/built/**/*`).filter((f) => statSync(f).isFile());
      const serveBuilt = globSync(`${serveOutDir}/img/built/**/*`).filter((f) => statSync(f).isFile());

      assert.ok(
        buildBuilt.length > 0,
        "build mode wrote no files under img/built/ — the baseline for this comparison is broken",
      );
      assert.equal(
        serveBuilt.length,
        0,
        `serve mode wrote ${serveBuilt.length} file(s) under img/built/ — transformOnRequest did not defer image generation`,
      );

      const buildHtml = readFileSync(`${buildOutDir}/articles/fixture-article/index.html`, "utf8");
      const serveHtml = readFileSync(`${serveOutDir}/articles/fixture-article/index.html`, "utf8");

      assert.ok(
        /<source[^>]+srcset="\/img\/built\//.test(buildHtml),
        "build-mode HTML does not link a static /img/built/ URL",
      );
      assert.ok(
        !buildHtml.includes("/.11ty/image/"),
        "build-mode HTML unexpectedly routes through the on-request image handler",
      );
      assert.ok(
        serveHtml.includes("/.11ty/image/"),
        "serve-mode HTML does not route through the on-request image handler — transformOnRequest had no observable effect",
      );
      assert.ok(
        !/<source[^>]+srcset="\/img\/built\//.test(serveHtml),
        "serve-mode HTML links a static /img/built/ URL — images were generated eagerly instead of deferred to request time",
      );
    } finally {
      rmSync(buildOutDir, { recursive: true, force: true });
      rmSync(serveOutDir, { recursive: true, force: true });
    }
  },
);

await checkAsync(
  "optimised images survive a wiped _site without re-encoding",
  async () => {
    // Port source imagePlugin.js:150-175, ported unchanged: on `build`,
    // eleventyImageTransformPlugin's outputDir is `.cache/@11ty/img/` (TEMP_DIR),
    // not `_site/img/built/` directly, and an `eleventy.after` hook `fs.cpSync`s
    // TEMP_DIR into the real output afterwards. `rm -rf _site` never touches
    // `.cache/`, so wiping and rebuilding _site should reuse whatever TEMP_DIR
    // already holds instead of re-encoding every image from scratch.
    //
    // Timing is a weak signal here (flaky, machine-dependent), so this drives
    // eleventy-img's own bookkeeping instead of a stopwatch. Its internal
    // DiskCache (src/disk-cache.js, exposed via src/caches.js) counts a `hit`
    // when `isOutputCached()` finds the target file already on disk — the exact
    // branch that SKIPS the Sharp encode entirely (src/image.js:710, `continue`
    // with no `fsp.writeFile` for that output) — and a `miss` otherwise. A build
    // that reused .cache for every image is observable as hits > 0 and
    // misses === 0; a build against an empty cache is observable as misses > 0.
    // Confirmed by hand before wiring this in: a fresh (.cache-empty) build of
    // this site reports 1 miss, 0 hits; rebuilding _site alone against that
    // same warm .cache reports 0 misses, 1 hit, in 0.5s vs 4.9s, and the built
    // .avif file's bytes are byte-for-byte identical across both builds.
    //
    // Each build below runs in its own child process (like the run-mode probe
    // above) so the DiskCache singleton — module-scoped, persists for a
    // process's lifetime — starts counting from zero every time, rather than
    // accumulating hits left over from earlier checks in this same file that
    // also build against the shared `.cache/@11ty/img/`.
    const probeScript = "_probe-image-cache-durability.mjs";
    const probeSource = `import Eleventy from "@11ty/eleventy";
import { diskCache } from "@11ty/eleventy-img/src/caches.js";

const outDir = process.argv[2];

const start = Date.now();
const elev = new Eleventy(undefined, outDir, { source: "cli", quietMode: true });
await elev.write();
const elapsedMs = Date.now() - start;

const [hits, misses] = diskCache.getCount();
process.stdout.write("\\nPROBE_RESULT:" + JSON.stringify({ hits, misses, elapsedMs }) + "\\n");
`;

    const runBuild = () => {
      const stdout = execFileSync(process.execPath, [probeScript, "_site"], {
        stdio: "pipe",
        // This check wipes .cache/ to force a cold image build — which also
        // clears .cache/eleventy-fetch/, the npm-downloads cache. Without this
        // override the probe re-fetches api.npmjs.org for real, breaking the
        // suite's no-network contract on a bare `npm test`. Same convention as
        // the run-mode probe above.
        env: { ...process.env, NPM_DOWNLOADS_OFFLINE: "1" },
      }).toString("utf8");
      const match = /PROBE_RESULT:(\{.*\})/.exec(stdout);
      assert.ok(match, `image-cache probe produced no PROBE_RESULT — got: ${stdout.slice(0, 500)}`);
      return JSON.parse(match[1]);
    };

    writeFileSync(probeScript, probeSource);
    try {
      // Cold: wipe both _site and .cache so DiskCache starts genuinely empty.
      // This doubles as the red proof for the "misses === 0" assertion below —
      // a build with nothing cached MUST show misses, or that assertion would
      // be trivially true regardless of whether the durability behaviour works.
      rmSync("_site", { recursive: true, force: true });
      rmSync(".cache", { recursive: true, force: true });
      const cold = runBuild();
      assert.ok(
        cold.misses > 0,
        `cold build (.cache empty) recorded 0 disk-cache misses (${JSON.stringify(cold)}) — this check would be vacuous`,
      );

      const sample = globSync("_site/img/built/*.avif")[0];
      assert.ok(sample, "cold build produced no built .avif files under _site/img/built/");
      const beforeBytes = readFileSync(sample);

      // Warm: wipe _site ONLY, keep .cache — the actual contract under test.
      rmSync("_site", { recursive: true, force: true });
      const warm = runBuild();

      assert.ok(
        existsSync(sample),
        `${sample} did not reappear after rebuilding with _site wiped but .cache intact`,
      );
      assert.deepEqual(
        readFileSync(sample),
        beforeBytes,
        `${sample} has different bytes after rebuild — it was re-encoded, not restored from .cache`,
      );
      assert.equal(
        warm.misses,
        0,
        `warm rebuild (_site wiped, .cache kept) recorded ${warm.misses} disk-cache miss(es) — some images were re-encoded instead of reused from .cache`,
      );
      assert.ok(
        warm.hits > 0,
        `warm rebuild recorded 0 disk-cache hits (${JSON.stringify(warm)}) — expected every built image to be served from .cache`,
      );

      console.log(
        `    cold build (.cache empty): ${cold.elapsedMs}ms (${cold.hits} hits, ${cold.misses} misses)`,
      );
      console.log(
        `    warm build (_site wiped, .cache kept): ${warm.elapsedMs}ms (${warm.hits} hits, ${warm.misses} misses)`,
      );
    } finally {
      rmSync(probeScript, { force: true });
    }
  },
);

// Task 18 (§7.4): default.liquid's `modules:` list referenced two files that
// don't exist in this repo (/static/heading-anchors.js,
// /static/js/time-difference.js) — a 404 on every page routed through
// default.liquid, invisible to every check above because nothing here
// asserted a *referenced* asset actually *exists*. The three checks below
// close both the specific bug (heading-anchors is now wired to real
// headings) and the general class of defect it belongs to — this is the
// third time a reference to a path this theme never builds has slipped
// through (/static/defer.css, the since-deleted toggle-button asset paths,
// now this); the
// last check asserts every same-origin <script src> / <link
// rel="stylesheet" href> on every built page resolves to a real file.
check("heading-anchors wraps the real e-content body in every post type that has one", () => {
  // Confirms the markup wiring, not just that the module file exists: a
  // <script src> that resolves to a real file which is never applied to any
  // heading would still pass every check above. Source (page.liquid:9-11,
  // post.liquid:55-57) wraps its content div's body in
  // <heading-anchors selector="h2,h3"> — h2,h3 because h1 is reserved for
  // the page/post title (layouts/entry.liquid's own <h1 class="p-name">,
  // Task S3), so body content headings start at h2. "like" has no e-content
  // div (its body is
  // just a URL, see types/like.liquid) — deliberately excluded, not missed.
  const types = ["article", "note", "bookmark", "reply", "photo"];
  for (const type of types) {
    const source = readFileSync(`_includes/types/${type}.liquid`, "utf8");
    assert.ok(
      source.includes('<heading-anchors selector="h2,h3">{{ content }}</heading-anchors>'),
      `_includes/types/${type}.liquid does not wrap {{ content }} in <heading-anchors selector="h2,h3">`,
    );
  }
});

await checkAsync(
  "heading-anchors' selector matches a real h2 in post body content, carrying the id IdAttributePlugin gave it",
  async () => {
    // The wiring check above only proves the markup is present in the
    // template source — not that it survives rendering with a real heading,
    // or that "h2,h3" actually matches ids IdAttributePlugin stamps on BODY
    // content, as opposed to only the h1 title (already covered by "…render
    // their microformats" above). Build one throwaway fixture with a real
    // markdown heading and confirm both land together, nested correctly.
    const fixturePath = "content/articles/_heading-anchors-check.md";
    const outDir = "_site-heading-anchors-check";
    const heading = "A Real Section Heading";
    const fixture = `---
date: 2026-08-30T10:00:00.000Z
title: Heading anchors check
eleventyExcludeFromCollections: true
---

## ${heading}

Body text.
`;

    writeFileSync(fixturePath, fixture);
    try {
      rmSync(outDir, { recursive: true, force: true });
      execFileSync(
        process.execPath,
        ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
        { stdio: "pipe" },
      );

      const outFile = `${outDir}/articles/_heading-anchors-check/index.html`;
      assert.ok(existsSync(outFile), `${outFile} was not built`);
      const html = readFileSync(outFile, "utf8");
      assert.ok(
        /<heading-anchors selector="h2,h3">\s*<h2 id="[a-z0-9-]+">A Real Section Heading<\/h2>/.test(html),
        "the body's h2 either has no id (IdAttributePlugin not reaching body content) or is not nested inside <heading-anchors selector=\"h2,h3\">",
      );
    } finally {
      rmSync(fixturePath, { force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  },
);

check("every same-origin script src, stylesheet href and image src emitted by any built page resolves to a real file in _site", () => {
  // No exemptions. The one that lived here — /static/infinity-burger.js —
  // was for a decorative easter egg whose JS does not exist in the port
  // source either; the markup has been removed rather than carried.
  const referenceExempt = new Set();

  const files = globSync("_site/**/*.html");
  assert.ok(files.length > 0, "no HTML built — this check scanned nothing");

  let scriptCount = 0;
  let stylesheetCount = 0;
  let imageCount = 0;
  const seenExempt = new Set();

  for (const file of files) {
    const html = readFileSync(file, "utf8");

    const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"[^>]*>/g)].map((m) => m[1]);
    const stylesheetHrefs = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)]
      .map((m) => m[0].match(/href="([^"]+)"/)?.[1])
      .filter(Boolean);

    // <img src> was the one element class this guard did not cover, and the
    // photo post — the one type whose entire purpose is an image — 404'd on
    // it. The fixture's src was correct and asserted; nothing checked the
    // file was ever built.
    const imageSrcs = [...html.matchAll(/<img[^>]+src="([^"]+)"[^>]*>/g)].map((m) => m[1]);

    for (const src of scriptSrcs) {
      if (!src.startsWith("/") || src.startsWith("//")) continue; // external / protocol-relative
      scriptCount++;
      if (referenceExempt.has(src)) {
        seenExempt.add(src);
        continue;
      }
      const cleanPath = src.split(/[?#]/)[0];
      assert.ok(
        existsSync(`_site${cleanPath}`),
        `${file} references script ${src}, which does not exist in _site`,
      );
    }

    for (const href of stylesheetHrefs) {
      if (!href.startsWith("/") || href.startsWith("//")) continue;
      stylesheetCount++;
      const cleanPath = href.split(/[?#]/)[0];
      assert.ok(
        existsSync(`_site${cleanPath}`),
        `${file} references stylesheet ${href}, which does not exist in _site`,
      );
    }

    for (const src of imageSrcs) {
      if (!src.startsWith("/") || src.startsWith("//")) continue;
      imageCount++;
      const cleanPath = src.split(/[?#]/)[0];
      assert.ok(
        existsSync(`_site${cleanPath}`),
        `${file} references image ${src}, which does not exist in _site`,
      );
    }
  }

  // Non-vacuous: a change that stopped this check from finding any scripts
  // or stylesheets at all must fail loudly, not pass by having nothing left
  // to inspect.
  assert.ok(scriptCount > 0, "no same-origin scripts found across any built page — this check is vacuous");
  assert.ok(imageCount > 0, "no same-origin images found across any built page — this check is vacuous");
  assert.ok(stylesheetCount > 0, "no same-origin stylesheets found across any built page — this check is vacuous");

  // The exemption must not rot: it has to actually be exercised (still
  // referenced somewhere) so a future cleanup that removes the reference
  // also has to remove the now-dead exemption entry.
  for (const exempt of referenceExempt) {
    assert.ok(seenExempt.has(exempt), `${exempt} is exempted but no page references it — remove the stale exemption`);
  }
});

await checkAsync(
  "pagefind indexes only content pages — the homepage and the search page itself are excluded",
  async () => {
    // Task 19 (§9.1). package.json's search-index script now scopes
    // Pagefind's --glob to the six post-type output directories, mirroring
    // the port source's own {web,resume} scoping (search.html's sibling
    // eleventy.config.js) — the homepage (an h-feed listing every post) and
    // the search page itself must never enter the index. A check that only
    // asserts "an index got built" would pass identically whether the
    // scoping worked or Pagefind indexed the entire site — this actually
    // runs Pagefind against the real build, decompresses every resulting
    // fragment (each is gzip: "pagefind_dcd" + JSON, confirmed by hand with
    // zcat before wiring this in) and reads back the exact set of indexed
    // URLs, rather than trusting a glob string or a file count.
    //
    // Runs against the real `_site` produced above the same way "every
    // same-origin script src…" does; --output-path keeps Pagefind's own
    // output out of `_site/pagefind` so this doesn't race or interfere with
    // that check.
    //
    // The glob is extracted from eleventy.config.js rather than hardcoded a
    // second time here — a hardcoded copy would let this check keep passing
    // even if the real glob regressed to an unscoped one, since nothing would
    // ever exercise the string that runs. It used to be read from a
    // `search-index` npm script; indexing moved into the eleventy.after hook
    // (that separate script broke search, see eleventy.config.js), so the
    // script was dead config and reading it validated a value that no longer
    // ran. Read the live one.
    const configSource = readFileSync("eleventy.config.js", "utf8");
    const globMatch = /glob:\s*"([^"]+)"/.exec(configSource);
    assert.ok(
      globMatch,
      "eleventy.config.js has no `glob:` scoping the Pagefind index",
    );
    const glob = globMatch[1];

    const outputPath = "_site-pagefind-check";
    rmSync(outputPath, { recursive: true, force: true });
    try {
      execFileSync(
        "node_modules/.bin/pagefind",
        ["--site", "_site", "--glob", glob, "--output-path", outputPath],
        { stdio: "pipe", env: { ...process.env, NPM_DOWNLOADS_OFFLINE: "1" } },
      );

      const fragments = globSync(`${outputPath}/fragment/*.pf_fragment`);
      assert.ok(fragments.length > 0, "pagefind produced no fragments — this check would be vacuous");

      const indexedUrls = fragments
        .map((f) => {
          const decompressed = gunzipSync(readFileSync(f)).toString("utf8");
          return JSON.parse(decompressed.replace(/^pagefind_dcd/, "")).url;
        })
        .sort();

      // Independently derived from the real build output (not from the
      // glob string itself, which would make this circular) — every
      // index.html actually built under one of the six post-type
      // directories, converted to the same clean-URL shape Pagefind reports.
      const expectedUrls = globSync("_site/{articles,bookmarks,likes,notes,photos,replies}/*/index.html")
        .map((f) => `/${f.replace(/^_site\//, "").replace(/index\.html$/, "")}`)
        .sort();

      assert.ok(expectedUrls.length > 0, "no built content pages found under _site — this check would be vacuous");
      assert.deepEqual(
        indexedUrls,
        expectedUrls,
        `indexed URL set does not match the built content-page set\n  indexed:  ${JSON.stringify(indexedUrls)}\n  expected: ${JSON.stringify(expectedUrls)}`,
      );

      for (const excludedUrl of ["/", "/search/"]) {
        assert.ok(
          !indexedUrls.includes(excludedUrl),
          `${excludedUrl} was indexed even though it falls outside the scoped glob — the scoping failed`,
        );
      }

      // Task 20, named explicitly (not just implied by the deepEqual
      // above): content/opengraph-images.liquid builds a real page per post
      // under _site/opengraph/**, outside every one of the six directories
      // the glob allow-lists — plan Task 20 step 5's own note that this is
      // already covered by the existing scoping, not something needing new
      // machinery. Fails loudly, and independently of the deepEqual, if a
      // future glob change ever widens to include it.
      assert.ok(
        indexedUrls.every((u) => !u.startsWith("/opengraph/")),
        `OG card page(s) were indexed by pagefind: ${indexedUrls.filter((u) => u.startsWith("/opengraph/")).join(", ")}`,
      );
    } finally {
      rmSync(outputPath, { recursive: true, force: true });
    }
  },
);

check("the search page ships a real, unguarded <form> as its no-JS fallback", () => {
  // Task 19 (§9.2). @zachleat/pagefind-search's connectedCallback() only
  // discards its light-DOM children once pagefind-search.js actually loads
  // and the element upgrades — verified by reading
  // node_modules/@zachleat/pagefind-search/pagefind-search.js directly, not
  // assumed from the README. So the <form> inside <pagefind-search> in
  // content/search.md IS the no-JS fallback, and it only works as one if it
  // is real markup present unconditionally — not inside the
  // `{% if JS_ENABLED %}` guard that wraps the pagefind-search.js <script>
  // tag and the ?q= deep-link <script> right next to it.
  //
  // A check that just grep'd the whole rendered page for `<form` and
  // `type="submit"` separately would pass even if both moved inside an
  // `{% if JS_ENABLED %}` block, or even if they ended up in two unrelated
  // parts of the page — this instead isolates the exact
  // `<pagefind-search>…</pagefind-search>` element (the thing whose
  // JS-driven replaceChildren() is what makes "outside the guard" matter at
  // all), and checks the form is nested inside SPECIFICALLY that, with a
  // real submit control, in the actually-built output — not the source
  // template — so a Liquid conditional wrapping it at render time would
  // still be caught.
  const html = readFileSync("_site/search/index.html", "utf8");

  const pagefindSearchMatch = /<pagefind-search[^>]*>([\s\S]*?)<\/pagefind-search>/.exec(html);
  assert.ok(pagefindSearchMatch, "no <pagefind-search> element found in the built search page");

  const inner = pagefindSearchMatch[1];
  assert.ok(
    /<form[^>]*\bmethod="get"[^>]*>[\s\S]*<\/form>/.test(inner),
    "<pagefind-search> does not contain a <form method=\"get\">…</form> — the no-JS fallback is missing",
  );
  assert.ok(
    /<button[^>]*\btype="submit"[^>]*>/.test(inner) || /<input[^>]*\btype="submit"[^>]*>/.test(inner),
    "the fallback form has no submit control (button/input type=\"submit\")",
  );

  // The specific defect this guards against: the whole
  // <pagefind-search>...</pagefind-search> block sitting inside an
  // `{% if JS_ENABLED %}` in the template, which would make it vanish
  // from a JS_ENABLED=false build entirely rather than degrade to a form.
  // Prove it directly against a real JS_ENABLED=false build, not by
  // re-reading the Liquid source (which can't tell where a conditional's
  // boundaries actually land after rendering).
  const outDir = "_site-search-nojs-check";
  rmSync(outDir, { recursive: true, force: true });
  try {
    const configPath = "eleventy.config.js";
    const original = readFileSync(configPath, "utf8");
    const patched = original.replace(
      "const JS_ENABLED = true;",
      "const JS_ENABLED = false;",
    );
    assert.notEqual(patched, original, "could not locate `const JS_ENABLED = true;` to patch — check drifted from source");
    writeFileSync(configPath, patched);
    try {
      execFileSync(
        process.execPath,
        ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
        { stdio: "pipe", env: { ...process.env, NPM_DOWNLOADS_OFFLINE: "1" } },
      );
    } finally {
      writeFileSync(configPath, original);
      assert.ok(
        readFileSync(configPath, "utf8") === original,
        "eleventy.config.js was not restored to its original contents",
      );
    }

    const noJsHtml = readFileSync(`${outDir}/search/index.html`, "utf8");
    const noJsMatch = /<pagefind-search[^>]*>([\s\S]*?)<\/pagefind-search>/.exec(noJsHtml);
    assert.ok(noJsMatch, "<pagefind-search> is missing entirely from a JS_ENABLED=false build — the no-JS fallback was guarded away");
    assert.ok(
      /<form[^>]*\bmethod="get"[^>]*>[\s\S]*<\/form>/.test(noJsMatch[1]),
      "the fallback <form> is missing from a JS_ENABLED=false build",
    );
    assert.ok(
      !noJsHtml.includes("/pagefind-search.js"),
      "pagefind-search.js is still referenced in a JS_ENABLED=false build — the JS_ENABLED guard around its <script> tag is not working",
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- Task 20: Open Graph card pages -----------------------------------

check("OG card pages build one per built post, at the permalink adapted to content/'s own permalink scheme", () => {
  // content/opengraph-images.liquid paginates collections.post with
  // permalink "/opengraph{{ entry.url }}". Derive the expected set from the
  // real built post pages (not from the front-matter permalink string
  // itself, which would make this circular) — the same approach the
  // pagefind check above uses for its own expected set.
  const postPages = globSync("_site/{articles,bookmarks,likes,notes,photos,replies}/*/index.html");
  assert.ok(postPages.length > 0, "no built post pages found under _site — this check would be vacuous");
  for (const postPage of postPages) {
    const permalink = postPage.replace(/^_site/, "").replace(/index\.html$/, "");
    const cardPage = `_site/opengraph${permalink}index.html`;
    assert.ok(existsSync(cardPage), `no OG card built at ${cardPage} for post ${postPage}`);
  }

  // The draft note (content/notes/fixture-draft-note.md) is dropped from
  // collections.post entirely under a build-mode run (eleventy.config.js's
  // drafts preprocessor) — it must have no card either, not a leftover one
  // for a page that was never actually published.
  assert.ok(
    !existsSync("_site/opengraph/notes/fixture-draft-note/index.html"),
    "a dropped draft still got an OG card — it should not have been paginated at all",
  );
});

await checkAsync(
  "OG card page set is gated to build mode only — one per non-draft post under build, zero under serve",
  async () => {
    // Plan Task 20 step 2: report the flag and the count in both modes.
    // Flag: process.env.ELEVENTY_RUN_MODE === "build" (eleventy.config.js's
    // OG_CARD_TEMPLATE ignore, imagePlugin.js's IMAGE_CACHE_DURATION, and
    // the drafts preprocessor all already key on the same value — this
    // reuses that idiom rather than a second custom env var like source's
    // own PRODUCTION_BUILD).
    //
    // `--serve` starts a real dev server (forbidden here). The only way to
    // reach runMode "serve" without one is programmatic — same pattern as
    // "under serve mode, critical CSS is linked..." above.
    const buildOutDir = "_site-og-mode-build";
    const serveOutDir = "_site-og-mode-serve";
    rmSync(buildOutDir, { recursive: true, force: true });
    rmSync(serveOutDir, { recursive: true, force: true });
    try {
      const build = new Eleventy(undefined, buildOutDir, { source: "cli", quietMode: true });
      await build.write();
      const serve = new Eleventy(undefined, serveOutDir, {
        source: "cli",
        quietMode: true,
        runMode: "serve",
      });
      await serve.write();

      const buildCards = globSync(`${buildOutDir}/opengraph/**/*.html`);
      const serveCards = globSync(`${serveOutDir}/opengraph/**/*.html`);

      // Independently derived expected count: every post actually built
      // under build mode (the draft is already excluded from this set by
      // the drafts preprocessor, not by this check).
      const builtPosts = globSync(`${buildOutDir}/{articles,bookmarks,likes,notes,photos,replies}/*/index.html`);
      assert.ok(builtPosts.length > 0, "no posts built under build mode — this check would be vacuous");

      assert.equal(
        buildCards.length,
        builtPosts.length,
        `build mode: expected one OG card per built post (${builtPosts.length}), got ${buildCards.length}`,
      );
      assert.equal(
        serveCards.length,
        0,
        `serve mode: expected 0 OG cards (ELEVENTY_RUN_MODE gate), got ${serveCards.length}`,
      );
    } finally {
      rmSync(buildOutDir, { recursive: true, force: true });
      rmSync(serveOutDir, { recursive: true, force: true });
    }
  },
);

check("each post type's OG card carries its own type-appropriate content, not an empty heading", () => {
  // Plan Task 20 step 3's exact per-type table. Reads each real built card
  // rather than grepping the whole _site tree for a string, so a match in
  // the wrong file (or the wrong post's card) can't produce a false pass.
  // Earlier checks in this file wipe and rebuild _site (the image-cache
  // durability check) and temporarily mutate fixtures (the escaping check),
  // so ambient _site state is not reliable by the time this runs. Build a
  // dedicated copy instead of reading whatever happens to be on disk.
  execFileSync(process.execPath, ["node_modules/.bin/eleventy", "--quiet"], {
    stdio: "pipe",
    env: { ...process.env, NPM_DOWNLOADS_OFFLINE: "1" },
  });
  const card = (permalink) => readFileSync(`_site/opengraph${permalink}index.html`, "utf8");

  // article: its own title, as a real heading — not empty.
  const article = card("/articles/fixture-article/");
  assert.ok(
    /<h1 class="og-hed"(?: id="[^"]*")?><span class="og-box">Publishing to your own site first<\/span><\/h1>/.test(article),
    `article card heading missing or wrong: ${article}`,
  );

  // note: its own content, HTML-stripped — never the synthetic
  // "Note · <date>" fallback title eleventyComputed.js gives it elsewhere.
  const note = card("/notes/fixture-note/");
  assert.ok(note.includes("webmention spec again"), `note card does not carry its own body content: ${note}`);
  assert.ok(!note.includes("Note ·"), `note card leaked the synthetic date-label title instead of its own content: ${note}`);

  // bookmark: kicker + the bookmarked page's title.
  const bookmark = card("/bookmarks/fixture-bookmark/");
  assert.ok(bookmark.includes("Bookmarked · example.com"), `bookmark card missing its kicker: ${bookmark}`);
  assert.ok(bookmark.includes("A field guide to static site generators"), `bookmark card missing its title: ${bookmark}`);

  // untitled bookmark: kicker + the URL itself (eleventyComputed.js's own
  // "title, else the URL" fallback, reused here rather than reinvented).
  const untitledBookmark = card("/bookmarks/fixture-untitled-bookmark/");
  assert.ok(
    untitledBookmark.includes("https://example.com/untitled-bookmark-fixture"),
    `untitled bookmark card did not fall back to its URL: ${untitledBookmark}`,
  );

  // like: the honest sparse case — kicker + hostname, and DELIBERATELY no
  // invented headline (no <h1> at all — this theme has no "liked title"
  // data to show).
  const like = card("/likes/fixture-like/");
  assert.ok(like.includes("Liked · example.com"), `like card missing its kicker: ${like}`);
  assert.ok(!/<h1/.test(like), `like card invented a headline where the spec calls for a sparse card: ${like}`);

  // reply: kicker naming the target, but the HEADLINE is the reply's own
  // words — never the target URL itself appearing as the heading text.
  const reply = card("/replies/fixture-reply/");
  assert.ok(reply.includes("Reply to · example.com"), `reply card missing its kicker: ${reply}`);
  assert.ok(reply.includes("content-addressed"), `reply card does not show its own words: ${reply}`);
  assert.ok(
    !/<h1[^>]*>.*example\.com\/z.*<\/h1>/.test(reply),
    `reply card's heading shows the parent's URL instead of the reply's own content: ${reply}`,
  );

  // photo: still gets a card (archive consistency), captioned from its own
  // alt text, with the photo as the card's own background.
  const photo = card("/photos/fixture-photo/");
  assert.ok(
      photo.includes("A long exposure of the coast at dusk"),
      `photo card missing its caption: ${photo}`,
    );
  assert.ok(
    photo.includes("--og-bgimage: url('http://localhost:8080/media/sample.png')"),
    `photo card background does not reference the post's own photo: ${photo}`,
  );
});

check("og:image on every built post/homepage page is the right mechanism and never empty", () => {
  // Plan Task 20 step 6. Default config (site.json's opengraph.
  // screenshotUrlTemplate is empty) — cardsEnabled() is false, so every
  // non-photo page falls back to the static default image; the photo post
  // uses its own photo. Neither is ever "" (contrast the port source,
  // imagePlugin.js:219 — see content/opengraph-images.liquid's front-matter
  // comment for why that isn't ported).
  const pages = globSync("_site/{index,articles/*/index,notes/*/index,bookmarks/*/index,likes/*/index,replies/*/index,photos/*/index}.html");
  assert.ok(pages.length > 0, "no pages found — this check would be vacuous");

  for (const file of pages) {
    const html = readFileSync(file, "utf8");
    const ogImage = html.match(/<meta property="og:image" content="([^"]*)">/);
    const twitterImage = html.match(/<meta name="twitter:image" content="([^"]*)">/);
    assert.ok(ogImage, `no og:image tag at all in ${file}`);
    assert.ok(twitterImage, `no twitter:image tag at all in ${file}`);
    assert.notEqual(ogImage[1], "", `og:image is an empty string in ${file} — must fall back to the default image instead`);
    assert.equal(ogImage[1], twitterImage[1], `og:image and twitter:image disagree in ${file} — both must come from the same ogImageSource call`);

    if (file.startsWith("_site/photos/")) {
      assert.equal(
        ogImage[1],
        "http://localhost:8080/media/sample.png",
        `photo post's og:image does not point at its own photo: ${file} -> ${ogImage[1]}`,
      );
    } else {
      assert.equal(
        ogImage[1],
        "http://localhost:8080/img/og-default.png",
        `expected the static default image (cards disabled by default) in ${file}, got ${ogImage[1]}`,
      );
    }

    // Mechanism separation, checked on the tag VALUES specifically (not the
    // whole page — base.liquid's unrelated <link rel="preconnect"> hint to
    // that same host is pre-existing and out of scope here): og:image must
    // never be built from getOpenGraphImageUrl (mechanism 2 —
    // v1.opengraph.11ty.dev, which reads a THIRD-PARTY page's own og:image
    // and has no business filling this site's own tag).
    assert.ok(
      !ogImage[1].includes("opengraph.11ty.dev"),
      `${file}'s og:image references mechanism 2 (v1.opengraph.11ty.dev): ${ogImage[1]}`,
    );
  }
});

await checkAsync(
  "og:image uses the screenshot-card mechanism only when configured for a publicly reachable site.url, and never for localhost",
  async () => {
    // Mirrors the "speedlify renders..." check's throwaway-site.json
    // pattern. Two builds: (a) a template configured but site.url still
    // the theme's own localhost default — must refuse and fall back to the
    // static default, with no "localhost" ever inside an emitted
    // screenshot URL; (b) template + a publicly-reachable site.url — must
    // emit the real screenshot URL, still never for the photo post.
    const sitePath = "_data/site.json";
    const original = readFileSync(sitePath);
    const template = "https://screenshot.example.org/{url}/opengraph/";
    const localOutDir = "_site-og-cards-localhost-check";
    const publicOutDir = "_site-og-cards-public-check";

    try {
      const config = JSON.parse(original.toString("utf8"));
      config.opengraph.screenshotUrlTemplate = template;
      // config.url is left at its existing http://localhost:8080 default.
      writeFileSync(sitePath, JSON.stringify(config, null, 2) + "\n");

      rmSync(localOutDir, { recursive: true, force: true });
      execFileSync(
        process.execPath,
        ["node_modules/.bin/eleventy", `--output=${localOutDir}`, "--quiet"],
        { stdio: "pipe", env: { ...process.env, NPM_DOWNLOADS_OFFLINE: "1" } },
      );
      const localHtml = readFileSync(`${localOutDir}/articles/fixture-article/index.html`, "utf8");
      const localOgImage = localHtml.match(/<meta property="og:image" content="([^"]*)">/)[1];
      assert.equal(
        localOgImage,
        "http://localhost:8080/img/og-default.png",
        `a configured screenshotUrlTemplate against a localhost site.url must still fall back to the default image, got ${localOgImage}`,
      );
      // The default image itself legitimately lives on site.url (which IS
      // localhost here by design — a dev checkout of this theme) — the
      // requirement is that the CONFIGURED SCREENSHOT SERVICE is never
      // handed that localhost target, not that "localhost" can't appear in
      // og:image at all. The equality assertion above already proves no
      // screenshot-template URL was built; this names the mechanism it must
      // not be, for a reader who skips straight to this assertion.
      assert.ok(
        !localOgImage.includes("screenshot.example.org"),
        `no localhost target may ever reach the configured screenshot service, got ${localOgImage}`,
      );

      config.url = "https://example.org";
      writeFileSync(sitePath, JSON.stringify(config, null, 2) + "\n");

      rmSync(publicOutDir, { recursive: true, force: true });
      execFileSync(
        process.execPath,
        ["node_modules/.bin/eleventy", `--output=${publicOutDir}`, "--quiet"],
        { stdio: "pipe", env: { ...process.env, NPM_DOWNLOADS_OFFLINE: "1" } },
      );
      const publicArticleHtml = readFileSync(`${publicOutDir}/articles/fixture-article/index.html`, "utf8");
      const publicOgImage = publicArticleHtml.match(/<meta property="og:image" content="([^"]*)">/)[1];
      assert.equal(
        publicOgImage,
        `https://screenshot.example.org/${encodeURIComponent("https://example.org/opengraph/articles/fixture-article/")}/opengraph/`,
        `article og:image does not match the configured screenshot template, got ${publicOgImage}`,
      );

      const publicPhotoHtml = readFileSync(`${publicOutDir}/photos/fixture-photo/index.html`, "utf8");
      const publicPhotoOgImage = publicPhotoHtml.match(/<meta property="og:image" content="([^"]*)">/)[1];
      assert.equal(
        publicPhotoOgImage,
        "https://example.org/media/sample.png",
        `photo post's og:image must still be its own photo even with cards enabled, got ${publicPhotoOgImage}`,
      );
    } finally {
      writeFileSync(sitePath, original);
      rmSync(localOutDir, { recursive: true, force: true });
      rmSync(publicOutDir, { recursive: true, force: true });
      assert.ok(
        readFileSync(sitePath).equals(original),
        "_data/site.json was not restored to its original bytes",
      );
    }
  },
);

check("OG card pages appear in neither the Atom feed nor the homepage's h-feed", () => {
  // Plan Task 20 step 5. content/opengraph-images.liquid sets
  // eleventyExcludeFromCollections: true and carries no `tags: post` — both
  // the feed (feedPlugin's collection: "post") and the homepage
  // (collections.post | reverse) read only that same tagged collection, so
  // neither can pick up a card page. Asserted directly against the built
  // output rather than trusted by construction.
  const feed = readFileSync("_site/feed.xml", "utf8");
  assert.ok(!feed.includes("/opengraph/"), "an OG card URL leaked into the Atom feed");

  const home = readFileSync("_site/index.html", "utf8");
  assert.ok(!home.includes("/opengraph/"), "an OG card URL leaked into the homepage's h-feed");
});

// --- Task 20 review fix: attribute-injection and description-chain checks --

await checkAsync(
  "every meta content attribute — and the OG card's own render — survives an untrusted title/photo URL containing quotes, ampersands and angle brackets",
  async () => {
    // Review finding (blocker): og:image:alt, twitter:title, twitter:
    // description, twitter:image:alt (added by this task), and the
    // pre-existing og:title/og:description, all interpolated `title`/
    // `description` into a `content="..."` attribute with no escaping —
    // Micropub post titles are remote input. Reproduces the review's exact
    // repro string. Also covers opengraph-card.liquid's own <h1> (the same
    // title reaches the card's own heading) and its style="--og-bgimage:
    // url('...')" attribute (a photo URL is equally remote input, and was
    // never escaped at all, unlike og:image which goes through `new URL()`
    // and gets "/</>/ percent-encoded for free — see _includes/partials/
    // opengraph-card.liquid's own comment).
    const articlePath = "content/articles/fixture-article.md";
    const photoPath = "content/photos/fixture-photo.md";
    const originalArticle = readFileSync(articlePath, "utf8");
    const originalPhoto = readFileSync(photoPath, "utf8");
    const outDir = "_site-attribute-injection-check";
    // The review's own reproduction string, verbatim.
    const maliciousTitle = 'He said "hi" & <b>bold</b>';
    const maliciousPhotoUrl = '/media/sample.png" data-pwned="1';

    try {
      assert.ok(
        originalArticle.includes("title: Publishing to your own site first"),
        "fixture-article.md's title line has changed shape — update this check's replace target",
      );
      writeFileSync(
        articlePath,
        originalArticle.replace(
          "title: Publishing to your own site first",
          `title: ${JSON.stringify(maliciousTitle)}`,
        ),
      );
      assert.ok(
        originalPhoto.includes("url: /media/sample.png"),
        "fixture-photo.md's photo url line has changed shape — update this check's replace target",
      );
      writeFileSync(
        photoPath,
        originalPhoto.replace(
          "url: /media/sample.png",
          `url: ${JSON.stringify(maliciousPhotoUrl)}`,
        ),
      );

      rmSync(outDir, { recursive: true, force: true });
      execFileSync(
        process.execPath,
        ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
        { stdio: "pipe", env: { ...process.env, NPM_DOWNLOADS_OFFLINE: "1" } },
      );

      // 1. Every meta tag that interpolates title/description must parse as
      // a single well-formed `content="..."` attribute — not merely contain
      // the escaped string somewhere. A regex requiring the value to end in
      // `">` immediately (via `[^"]*` bounded by the surrounding literal
      // quotes) fails to match at all if an embedded raw `"` terminated the
      // attribute early, or a raw `<`/`>` corrupted the tag around it.
      const articleHtml = readFileSync(`${outDir}/articles/fixture-article/index.html`, "utf8");
      const metaPatterns = {
        "og:title": /<meta property="og:title" content="([^"]*)">/,
        "og:description": /<meta property="og:description" content="([^"]*)">/,
        "og:image:alt": /<meta property="og:image:alt" content="([^"]*)">/,
        "twitter:title": /<meta name="twitter:title" content="([^"]*)">/,
        "twitter:description": /<meta name="twitter:description" content="([^"]*)">/,
        "twitter:image:alt": /<meta name="twitter:image:alt" content="([^"]*)">/,
        description: /<meta name="description" content="([^"]*)">/,
      };
      const values = {};
      for (const [name, pattern] of Object.entries(metaPatterns)) {
        const match = articleHtml.match(pattern);
        assert.ok(
          match,
          `${name}'s meta tag did not parse as a single well-formed content="..." attribute — the malicious title broke out of it`,
        );
        values[name] = match[1];
        assert.ok(
          !match[1].includes("<"),
          `${name}'s content attribute contains a raw "<" — escaping failed: ${match[1]}`,
        );
      }

      // 2. Prove escaping actually ran (not just "nothing visibly broke") —
      // the three tags that embed the title verbatim must carry its escaped
      // form: an HTML entity for the embedded quote, the ampersand, and the
      // <b> tag.
      for (const name of ["og:title", "twitter:title", "og:image:alt", "twitter:image:alt"]) {
        const v = values[name];
        assert.ok(
          /&#34;|&quot;/.test(v),
          `${name} does not contain an escaped quote — title escaping is not wired up: ${v}`,
        );
        assert.ok(v.includes("&amp;"), `${name} does not contain an escaped ampersand: ${v}`);
        assert.ok(v.includes("&lt;b&gt;"), `${name} does not contain an escaped <b> tag: ${v}`);
      }

      // 3. The OG card's own heading (opengraph-card.liquid) — the review's
      // second reproduction: the raw <b> must never appear as a real element
      // in the card markup, only as its escaped text form.
      const cardHtml = readFileSync(`${outDir}/opengraph/articles/fixture-article/index.html`, "utf8");
      assert.ok(
        !cardHtml.includes("<b>bold</b>"),
        `OG card headline contains a literal, unescaped <b> element: ${cardHtml}`,
      );
      assert.ok(
        cardHtml.includes("&lt;b&gt;bold&lt;/b&gt;"),
        `OG card headline is not the escaped form of the malicious title: ${cardHtml}`,
      );

      // 4. The photo card's style="--og-bgimage: url('...')" attribute — a
      // raw quote in the photo URL must not break out of it and inject a
      // real HTML attribute.
      const photoCardHtml = readFileSync(`${outDir}/opengraph/photos/fixture-photo/index.html`, "utf8");
      assert.ok(
        !photoCardHtml.includes('data-pwned="1"'),
        `photo OG card's style attribute leaked a real, unescaped attribute from the photo URL: ${photoCardHtml}`,
      );
      const styleMatch = photoCardHtml.match(/<main class="[^"]*" style="([^"]*)">/);
      assert.ok(
        styleMatch,
        `photo OG card's <main style="..."> attribute did not parse as a single well-formed attribute: ${photoCardHtml}`,
      );
    } finally {
      writeFileSync(articlePath, originalArticle);
      writeFileSync(photoPath, originalPhoto);
      rmSync(outDir, { recursive: true, force: true });
      assert.equal(
        readFileSync(articlePath, "utf8"),
        originalArticle,
        "content/articles/fixture-article.md was not restored to its original contents",
      );
      assert.equal(
        readFileSync(photoPath, "utf8"),
        originalPhoto,
        "content/photos/fixture-photo.md was not restored to its original contents",
      );
    }
  },
);

check("og:description is the page's own text, never the old \"A post by \" placeholder, and differs across post types", () => {
  // Review finding (medium): og:description (and twitter:description, and
  // meta name=description) rendered the literal string "A post by " on
  // every page, because site.author.name is empty by design (this theme is
  // neutral). Spec §F.7's chain: explicit `description`, else the page's
  // own body text, else site.description — asserted against the real
  // baseline build (no fixture mutation needed: none of the fixtures set an
  // explicit `description`, so every page here already exercises the
  // "own body" or "site fallback" branch of the chain).
  const article = readFileSync("_site/articles/fixture-article/index.html", "utf8").match(
    /<meta property="og:description" content="([^"]*)">/,
  )[1];
  const note = readFileSync("_site/notes/fixture-note/index.html", "utf8").match(
    /<meta property="og:description" content="([^"]*)">/,
  )[1];
  const like = readFileSync("_site/likes/fixture-like/index.html", "utf8").match(
    /<meta property="og:description" content="([^"]*)">/,
  )[1];

  for (const [name, value] of [["article", article], ["note", note], ["like", like]]) {
    assert.notEqual(value, "", `${name}'s og:description is empty`);
    assert.ok(
      !value.startsWith("A post by"),
      `${name}'s og:description is still the old placeholder text: "${value}"`,
    );
  }

  // article and note each show their own fixture body text (syndicate elsewhere /
  // phrase from each — differs across post types, so a constant string would
  // fail this.
  assert.notEqual(article, note, "og:description is identical for article and note — looks like a constant, not per-page text");
  assert.ok(article.includes("syndicate elsewhere"), `article's og:description does not contain its own body text: "${article}"`);
  assert.ok(note.includes("webmention spec again"), `note's og:description does not contain its own body text: "${note}"`);

  // like's fixture has an empty body — proves the site.description fallback
  // fires rather than emitting an empty string.
  assert.equal(
    like,
    "A reference Eleventy theme for Indiekit.",
    `like's og:description (empty body, no explicit description) should fall back to site.description, got: "${like}"`,
  );
});


check("the Atom feed always names an author, and never an empty or placeholder one", () => {
  // RFC 4287 §4.2.1: atom:name must be non-empty, and atom:feed requires an
  // author unless every entry carries its own. This theme ships neutral
  // (site.json's author.name is ""), and eleventy-plugin-rss deep-merges
  // metadata over its own defaults, so both naive options ship broken feeds:
  // passing the empty author through yields <name></name> (invalid on every
  // clean checkout), and omitting the key yields the plugin's own
  // <name>Your Name</name> placeholder (valid, but a lie). The config falls
  // back to the site's own name; this guards both failure modes at once.
  const feed = readFileSync("_site/feed.xml", "utf8");
  const author = /<author>\s*<name>([\s\S]*?)<\/name>/.exec(feed);
  assert.ok(author, "feed has no <author><name> at all");
  assert.notEqual(author[1].trim(), "", "feed ships <name></name> — invalid per RFC 4287 §4.2.1");
  assert.notEqual(
    author[1].trim(),
    "Your Name",
    "feed ships eleventy-plugin-rss's placeholder author name, not the site's own",
  );
  const site = JSON.parse(readFileSync("_data/site.json", "utf8"));
  assert.equal(
    author[1].trim(),
    (site.author && site.author.name) || site.name,
    "feed author name is neither the configured author nor the site-name fallback",
  );
});

check("a post's Micropub categories become p-category on listing and permalink alike, and every tag page they link to is built", () => {
  // `category` is a first-class Micropub property. Before this, all six type
  // partials hardcoded an empty <span class="tags"></span> and nothing emitted
  // p-category anywhere, so every tag a user applied in their client vanished
  // at publish. Two separate render paths have to carry it — the feed listing
  // (post-list-entry.liquid, which passes an explicit local scope) and the
  // permalink (entry.liquid) — and an earlier pass had it on the listing only,
  // which is the render a consumer never fetches.
  const catOf = (html) =>
    [...html.matchAll(/<a class="tag p-category" href="([^"]+)">([^<]+)<\/a>/g)]
      .map((m) => ({ href: m[1], name: m[2] }));

  const permalinkCats = catOf(readFileSync("_site/articles/fixture-article/index.html", "utf8"));
  assert.ok(permalinkCats.length > 0, "the article permalink emits no p-category");

  // Listing rows deliberately carry NO categories. The row is a flex line whose
  // right-hand cluster is nowrap by construction (the dotted leader is
  // .tags::before), and a category is an unbounded user-authored string — one
  // long tag would blow out the reserved date column. They live on the
  // permalink and stay reachable through /tags/. Asserted, not just omitted, so
  // a future change cannot quietly put them back and re-break the row.
  const listingCats = catOf(readFileSync("_site/archive/index.html", "utf8"));
  assert.equal(
    listingCats.length,
    0,
    `listing rows emit p-category (${listingCats.map((c) => c.name).join(", ")}) — they belong on the permalink only`,
  );

  // Every category link must resolve — a tag page that was never built is the
  // exact failure the internal-link guard exists to catch, asserted here too
  // so this check fails for its own reason rather than a distant one.
  for (const cat of [...permalinkCats, ...listingCats]) {
    assert.ok(
      existsSync(`_site${cat.href}index.html`),
      `category link ${cat.href} points at a tag page that was never built`,
    );
  }

  // And a tag page must actually list its posts, not render an empty feed.
  for (const cat of permalinkCats) {
    const page = readFileSync(`_site${cat.href}index.html`, "utf8");
    const entries = (page.match(/class="h-entry"/g) || []).length;
    assert.ok(entries > 0, `tag page ${cat.href} lists no posts`);
  }
});

check("a syndicated post links its copies with u-syndication", () => {
  // Syndicating to Mastodon/Bluesky/LinkedIn is a core Indiekit feature, and
  // u-syndication is the only way a consumer can tie a copy back to the
  // original — without it Bridgy backfeed cannot associate a reply on the
  // silo with the post that produced it, so syndicated conversation never
  // comes home. The port source has no equivalent (it hardcodes tweet/toot
  // front matter with no mf2 class), so nothing would have caught this.
  const html = readFileSync("_site/articles/fixture-article/index.html", "utf8");
  const links = [...html.matchAll(/<a class="u-syndication" href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(links.length > 0, "the syndicated fixture post emits no u-syndication link");
  const fm = readFileSync("content/articles/fixture-article.md", "utf8");
  for (const url of links) {
    assert.ok(fm.includes(url), `u-syndication url ${url} is not in the post's own front matter`);
  }
  // A post with no syndication must emit none — not an empty list.
  const note = readFileSync("_site/notes/fixture-note/index.html", "utf8");
  assert.ok(
    !/u-syndication/.test(note),
    "a post with no syndication front matter still emits u-syndication markup",
  );
});

check("a configured author is published in every form mf2 and the fediverse actually read", () => {
  // The neutral default emits no author markup at all (by design — an empty
  // h-card or <meta name=author content=""> is worse than none), so every
  // check against the default build would pass with the whole integration
  // deleted. Build a throwaway output with an author configured and assert
  // each mechanism independently: mf2 author discovery has exactly three
  // inputs (p-author on the h-entry, p-author on the parent h-feed, or
  // rel=author -> h-card) and this theme supplies the first and third;
  // RelMeAuth needs MULTIPLE rel=me links, not one; Mastodon reads
  // fediverse:creator for link-preview attribution.
  const sitePath = "_data/site.json";
  const outDir = "_site-author-check";
  const original = readFileSync(sitePath);
  const author = {
    name: "Test Author",
    url: "https://example.com/",
    avatar: "",
    fediverse: "@test@example.social",
    me: ["https://github.com/test", "https://example.social/@test"],
  };

  try {
    const config = JSON.parse(original.toString("utf8"));
    config.author = author;
    writeFileSync(sitePath, JSON.stringify(config, null, 2) + "\n");

    rmSync(outDir, { recursive: true, force: true });
    execFileSync(
      process.execPath,
      ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
      { stdio: "pipe" },
    );

    const home = readFileSync(`${outDir}/index.html`, "utf8");
    assert.ok(
      home.includes(`<meta name="author" content="${author.name}">`),
      "configured author is missing from <meta name=author>",
    );
    assert.ok(
      home.includes(`<meta name="fediverse:creator" content="${author.fediverse}">`),
      "fediverse:creator is missing — Mastodon link previews lose author attribution",
    );
    const relMe = [...home.matchAll(/<link href="([^"]+)" rel="me">/g)].map((m) => m[1]);
    for (const url of [author.url, ...author.me]) {
      assert.ok(relMe.includes(url), `rel=me is missing ${url} — RelMeAuth needs every identity`);
    }
    assert.ok(
      relMe.length >= 3,
      `only ${relMe.length} rel=me link(s); a single scalar cannot express RelMeAuth cross-linking`,
    );
    assert.ok(
      home.includes(`<a rel="author" href="${author.url}">`),
      "rel=author is missing — the only author-discovery input that works on pages with no h-entry",
    );

    // p-author must sit INSIDE each h-entry to be that entry's author.
    for (const [label, file] of [
      ["listing", `${outDir}/archive/index.html`],
      ["permalink", `${outDir}/notes/fixture-note/index.html`],
    ]) {
      const blocks = extractHEntryBlocks(
        readFileSync(file, "utf8"),
        label === "listing" ? "li" : "article",
      );
      assert.ok(blocks.length > 0, `${label}: no h-entry blocks found`);
      for (const block of blocks) {
        assert.ok(
          /\bp-author\b/.test(block) && /\bh-card\b/.test(block),
          `${label}: an h-entry has no nested p-author h-card — the post is authorless to mf2 consumers`,
        );
      }
    }

    const feed = readFileSync(`${outDir}/feed.xml`, "utf8");
    assert.ok(
      feed.includes(`<name>${author.name}</name>`),
      "the configured author does not reach the Atom feed",
    );
  } finally {
    writeFileSync(sitePath, original);
    rmSync(outDir, { recursive: true, force: true });
    assert.ok(
      readFileSync(sitePath).equals(original),
      "_data/site.json was not restored to its original bytes",
    );
  }
});



check("prev/next navigation points at the real neighbouring posts, in the right direction", () => {
  // This port shipped the source's entire dl.nextprev design (18 rules in
  // _lists.scss) with no markup to match: readers could not move between posts
  // and every page paid for the dead bytes. Direction is the subtle part — the
  // source keeps its collection newest-first, so ITS getNextCollectionItem
  // returns the OLDER post; collections.post here is ascending, so it returns
  // the NEWER one. Copying the source's labels verbatim would point both arrows
  // backwards while still rendering perfectly. Verify against the archive's own
  // newest-first ordering rather than re-deriving dates.
  const archive = readFileSync("_site/archive/index.html", "utf8");
  const order = [...archive.matchAll(/<a class="posts-link[^"]*" href="(\/[a-z]+\/[^"]+\/)"/g)]
    .map((m) => m[1]);
  assert.ok(order.length >= 3, `archive lists ${order.length} posts — too few to check neighbours`);

  const navOf = (html) => {
    const dl = /<dl class="nextprev[^"]*">([\s\S]*?)<\/dl>/.exec(html);
    assert.ok(dl, "post page has no dl.nextprev");
    const older = /<dd class="nextprev-next">(?:\s*<a href="([^"]+)")?/.exec(dl[1]);
    const newer = /<dd class="nextprev-prev">(?:\s*<a href="([^"]+)")?/.exec(dl[1]);
    return { older: older && older[1], newer: newer && newer[1] };
  };

  for (const [i, url] of order.entries()) {
    const nav = navOf(readFileSync(`_site${url}index.html`, "utf8"));
    // order is newest-first: the NEXT index is older, the PREVIOUS is newer.
    const expectOlder = i + 1 < order.length ? order[i + 1] : undefined;
    const expectNewer = i > 0 ? order[i - 1] : undefined;
    assert.equal(
      nav.older || undefined, expectOlder,
      `${url}: "Older" points at ${nav.older}, expected ${expectOlder} — direction is reversed or wrong`,
    );
    assert.equal(
      nav.newer || undefined, expectNewer,
      `${url}: "Newer" points at ${nav.newer}, expected ${expectNewer} — direction is reversed or wrong`,
    );
  }

  // The endpoints must render EMPTY cells, not a link to themselves and not a
  // missing <dd> (dl.nextprev dd:empty is the rule that styles them).
  // The source's dt badge sits deliberately ON TOP of an og-image thumbnail
  // (dt and dd share grid-row 1, dt has z-index 1 + pointer-events: none).
  // These cells carry TEXT, so inheriting that overlap paints the badge over
  // the link title — confirmed unreadable in a browser. The .nextprev-text
  // variant stacks them; if that rule is lost the markup still renders and
  // only a human looking at it would notice, which is why this is asserted.
  const css = globSync("_site/_css/{initial,defer}.css")
    .map((f) => readFileSync(f, "utf8")).join("");
  const dtRule = /dl\.nextprev-text dt\s*\{([^}]*)\}/.exec(css);
  const ddRule = /dl\.nextprev-text dd\s*\{([^}]*)\}/.exec(css);
  assert.ok(dtRule && ddRule, "the .nextprev-text stacking rules are missing from the compiled CSS");
  const row = (rule) => /grid-row:\s*([^;]+)/.exec(rule)?.[1].trim();
  assert.ok(
    row(dtRule[1]) && row(ddRule[1]) && row(dtRule[1]) !== row(ddRule[1]),
    `.nextprev-text dt and dd share grid-row ${row(dtRule[1])} — the badge will overlap the link text`,
  );

  // `1fr` is minmax(auto, 1fr) and that auto minimum is MIN-CONTENT, so one
  // unbreakable string stops the column shrinking and pushes the grid past the
  // viewport. Real, not theoretical: a titleless bookmark's title falls back to
  // its own URL, so a neighbour's link text is routinely an unbreakable URL —
  // measured at 11px of horizontal overflow on the article permalink at 360px.
  const cols = /dl\.nextprev-text\s*\{([^}]*)\}/.exec(css);
  assert.ok(cols, "no dl.nextprev-text rule in the compiled CSS");
  assert.ok(
    /grid-template-columns:\s*minmax\(\s*0/.test(cols[1]),
    "dl.nextprev-text columns are not minmax(0, ...) — a long unbreakable neighbour title will overflow the viewport on narrow screens",
  );

  const newest = navOf(readFileSync(`_site${order[0]}index.html`, "utf8"));
  assert.ok(!newest.newer, `the newest post links to a newer post (${newest.newer})`);
  const oldest = navOf(readFileSync(`_site${order[order.length - 1]}index.html`, "utf8"));
  assert.ok(!oldest.older, `the oldest post links to an older post (${oldest.older})`);
});

check("a 404 page is built, and is kept out of the search index and the feed", () => {
  // Source ships 404.html; this port built none, so any host serving the theme
  // fell back to its own default error page. It must not leak into Pagefind
  // results or the Atom feed — a 404 turning up as a search hit is worse than
  // no 404 page at all.
  assert.ok(existsSync("_site/404.html"), "_site/404.html was not built");
  const html = readFileSync("_site/404.html", "utf8");
  assert.ok(
    !/data-pagefind-body/.test(html),
    "the 404 page is marked data-pagefind-body — it will show up as a search result",
  );
  assert.ok(
    /class="[^"]*h-entry/.test(html),
    "the 404 page lists no posts — the onward path for a lost reader is the point of it",
  );
  assert.ok(
    html.includes('href="/archive/"'),
    "the 404 page does not link onward to the archive",
  );
  assert.ok(
    !readFileSync("_site/feed.xml", "utf8").includes("404"),
    "the 404 page leaked into the Atom feed",
  );
});



check("every SVG <use> reference resolves to a <symbol> defined on the same page", () => {
  // The exact bug this exists for: @11ty/font-awesome files each icon's sprite
  // symbol against `this.page.url` (plugin.js:51). The listing partials are
  // included with a `page: post` override — deliberately, so date filters read
  // each post's own front matter — so every {% icon %} rendered inside that
  // override filed its symbol under the POST's url, while the listing page
  // emitted <use href="#fas-fa-reply-all"> for a symbol that was never in its
  // own bundle. The markup looked perfect and the icon painted NOTHING.
  // A second, independent way to break this: {% getBundle "fontawesome" %} was
  // commented out behind a stale TODO, so no page emitted a sprite at all.
  // Both are invisible to every other check in this file.
  const files = globSync("_site/**/*.html");
  assert.ok(files.length > 0, "no HTML produced — this check scanned nothing");
  const broken = [];
  let refs = 0;
  for (const file of files) {
    const html = readFileSync(file, "utf8");
    const symbols = new Set([...html.matchAll(/<symbol[^>]*\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const m of html.matchAll(/<use[^>]*?(?:xlink:)?href="#([^"]+)"/g)) {
      refs++;
      if (!symbols.has(m[1])) broken.push(`${file}: #${m[1]}`);
    }
  }
  assert.equal(
    broken.length,
    0,
    `SVG <use> references with no matching <symbol> on the page (the icon renders blank): ${[...new Set(broken)].join("; ")}`,
  );
  // Not vacuous only when icons actually ship; note it rather than assert, so a
  // build with no webmentions (every fresh install) still reports honestly.
  if (refs === 0) {
    console.log("    (note: no <use> references in this build — nothing to resolve)");
  }
});

check("every listing row carries one post-type icon with a text label", () => {
  const html = readFileSync("_site/index.html", "utf8");
  const rows = [...html.matchAll(/<li class="h-entry" data-post-type="(\w+)">([\s\S]*?)<\/li>/g)];
  assert.ok(rows.length >= 5, `only ${rows.length} listing rows found`);
  const expected = { article: "file-lines", note: "comment", photo: "image", like: "heart", reply: "reply", bookmark: "bookmark" };
  for (const [, type, body] of rows) {
    assert.match(body, /<span class="post-type-icon" aria-hidden="true">/, `${type}: no icon wrapper`);
    assert.ok(body.includes(`fa-${expected[type]}`) || body.includes(`#fa${expected[type].replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())}`),
      `${type}: icon is not ${expected[type]}`);
    assert.match(body, new RegExp(`<span class="sr-only">${type[0].toUpperCase()}${type.slice(1)}</span>`), `${type}: no sr-only label`);
  }
  const css = readFileSync("_site/_css/initial.css", "utf8");
  assert.match(css, /\.post-type-icon/, "no rule for .post-type-icon");
  assert.ok(!/data-post-type[^{]*::after/.test(css), "the CSS shape markers are still emitted");
});

check("listing rows use the short date format; permalinks keep the long one", () => {
  // "30 August 2026" is 14 characters and wrapped to two and three lines in the
  // row's reserved column, landing at a different x on every row — the reported
  // bug. listingDate (eleventy.config.js) emits "30 Aug", adding the year only
  // when it is not the current one so /archive/ and the tag pages stay
  // unambiguous. The two formats must not collapse into one.
  const listing = readFileSync("_site/archive/index.html", "utf8");
  const dates = [...listing.matchAll(/<time class="date dt-published"[^>]*>([^<]+)<\/time>/g)]
    .map((m) => m[1].trim());
  assert.ok(dates.length > 0, "the archive listing renders no dates");
  const currentYear = new Date().getFullYear();
  for (const d of dates) {
    assert.match(
      d,
      /^\d{1,2} [A-Z][a-z]{2}( \d{4})?$/,
      `listing date "${d}" is not the short "d MMM [yyyy]" form`,
    );
  }
  // The fixtures are all from the current year, so none may carry one.
  const withYear = dates.filter((d) => new RegExp(`${currentYear}$`).test(d));
  assert.equal(
    withYear.length,
    0,
    `current-year listing dates redundantly carry the year: ${withYear.join(", ")}`,
  );
  // And the permalink must still show the full, unabbreviated date.
  const page = readFileSync("_site/articles/fixture-article/index.html", "utf8");
  assert.match(
    page,
    /<time class="dt-published"[^>]*>\s*\d{1,2} [A-Z][a-z]{3,}\s+\d{4}\s*<\/time>/,
    "the permalink lost its long-form date — listingDate leaked onto the post page",
  );
});

check("listing excerpts carry no Truncated badge and no categories", () => {
  // Both used to sit inside the row: the badge came from the `truncate` filter
  // (a webmention affordance, meaningless in a listing) and, before p-name was
  // corrected, landed INSIDE the post's machine-readable name. Categories are
  // unbounded user strings that would blow out the nowrap meta column. Both
  // belong on the permalink, not the row.
  const rows = extractHEntryBlocks(readFileSync("_site/archive/index.html", "utf8"), "li");
  assert.ok(rows.length > 0, "no listing rows found — this check scanned nothing");
  for (const row of rows) {
    assert.ok(!/tag-inline/.test(row), `a listing row still renders the "Truncated" badge`);
    assert.ok(!/p-category/.test(row), `a listing row still renders a category`);
  }
  // The excerpt must still be truncated — just without the badge.
  assert.ok(
    rows.some((r) => /…/.test(r)),
    "no listing excerpt is truncated at all — the ellipsis went missing with the badge",
  );
});



check("SITE_FIXTURE overlays site config for templates AND config consumers, without touching site.json", () => {
  // The overlay reaches markup and the build config by two independent routes:
  // templates get it from _data/eleventyComputed.js's computed `site` (the only
  // tier that outranks a _data/* global), while eleventy.config.js, the feed
  // metadata and the data files read _11ty/siteConfig.js directly. Either route
  // can break alone, producing a build that renders an h-card for one identity
  // and a feed author for another — which looks fine on the page.
  const sitePath = "_data/site.json";
  const outDir = "_site-sitefixture-check";
  const original = readFileSync(sitePath);

  try {
    rmSync(outDir, { recursive: true, force: true });
    execFileSync(
      process.execPath,
      ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
      { stdio: "pipe", env: { ...process.env, SITE_FIXTURE: "test/fixtures/site-demo.json" } },
    );

    const fixture = JSON.parse(readFileSync("test/fixtures/site-demo.json", "utf8"));
    const name = fixture.author.name;

    // Route 1: templates.
    const home = readFileSync(`${outDir}/index.html`, "utf8");
    assert.ok(home.includes('class="h-card"'), "the overlay did not reach templates — no h-card rendered");
    assert.ok(home.includes(name), `the h-card does not carry the fixture's author name (${name})`);
    for (const meUrl of fixture.author.me) {
      assert.ok(home.includes(meUrl), `rel=me is missing the fixture's ${meUrl}`);
    }

    // Route 2: build config (the feed reads siteData at config time, not per page).
    const feed = readFileSync(`${outDir}/feed.xml`, "utf8");
    assert.ok(
      feed.includes(`<name>${name}</name>`),
      "the overlay did not reach eleventy.config.js — the feed still names the un-overlaid author",
    );

    // The base file must not be mutated: the whole point is previewing a
    // populated site without editing tracked configuration.
    assert.ok(
      readFileSync(sitePath).equals(original),
      "_data/site.json was modified by an overlaid build",
    );
    const base = JSON.parse(original.toString("utf8"));
    assert.equal(base.author.name, "", "the committed default is no longer neutral");

    // And the fixture must not change site.url, or the webmention demo fixture's
    // targets stop matching and every social count silently reads zero.
    assert.ok(
      !fixture.url,
      "site-demo.json overrides site.url — webmention fixture targets would no longer match",
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});



check("response posts cite their target as an h-cite, and never invent a citation name", () => {
  // The mf2 spec allows u-in-reply-to / u-like-of / u-repost-of / u-bookmark-of
  // to take a URL *or an embedded h-cite* (microformats.org/wiki/h-entry). The
  // embedded form is what lets a consumer show what is being responded to, so
  // the property belongs on the h-cite container and u-url on the anchor.
  const cases = [
    ["replies/fixture-reply", "u-in-reply-to"],
    ["likes/fixture-like", "u-like-of"],
    ["bookmarks/fixture-bookmark", "u-bookmark-of"],
    ["bookmarks/fixture-untitled-bookmark", "u-bookmark-of"],
  ];
  for (const [slug, property] of cases) {
    const html = readFileSync(`_site/${slug}/index.html`, "utf8");
    const cite = new RegExp(`class="${property} h-cite"([\\s\\S]*?)<\\/(?:div|span)>`).exec(html);
    assert.ok(cite, `${slug}: no <… class="${property} h-cite"> — the property is not on a citation`);

    // The property must NOT also sit on the inner anchor: mf2 says a property
    // "should only be showing up on one of them".
    const anchor = /<a class="([^"]*)"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(cite[1]);
    assert.ok(anchor, `${slug}: the h-cite contains no anchor`);
    assert.ok(!anchor[1].includes(property), `${slug}: ${property} is duplicated onto the citation's anchor`);
    assert.ok(/\bu-url\b/.test(anchor[1]), `${slug}: the citation's anchor has no u-url`);

    // p-name only when there is a real name. An untitled bookmark's title falls
    // back to its own url; claiming that as the citation's name asserts a url is
    // a title — the same falsehood removed from post p-name.
    const text = anchor[3].replace(/<[^>]*>/g, "").trim();
    if (anchor[1].includes("p-name")) {
      assert.notEqual(text, anchor[2], `${slug}: claims p-name whose text is just the url`);
    }
  }
});

await checkAsync("a citation enriches with author and published when the client sends an object", async () => {
  // Indiekit writes inReplyTo as a bare url string, so the enrichment path has
  // no fixture in the normal build. JF2 permits a nested object, and the
  // template accepts either — untested code being a liability, drive the object
  // shape through a real build rather than trusting it.
  const fixture = "content/replies/_cite-object-check.md";
  const outDir = "_site-cite-check";
  writeFileSync(fixture, [
    "---",
    "date: 2026-08-30T09:00:00.000Z",
    "inReplyTo:",
    "  url: https://example.com/cited-post",
    "  name: The cited post's real title",
    "  published: 2026-08-29T10:00:00.000Z",
    "  author:",
    "    name: A Cited Author",
    "    url: https://example.com/author",
    "---",
    "",
    "A reply whose target arrived as a structured object.",
    "",
  ].join("\n"));

  try {
    rmSync(outDir, { recursive: true, force: true });
    execFileSync(process.execPath,
      ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"], { stdio: "pipe" });

    const html = readFileSync(`${outDir}/replies/_cite-object-check/index.html`, "utf8");
    const cite = /class="u-in-reply-to h-cite"([\s\S]*?)<\/div>/.exec(html);
    assert.ok(cite, "object-shaped reply target produced no h-cite");
    assert.ok(
      /<a class="u-url p-name"[^>]*href="https:\/\/example\.com\/cited-post"/.test(cite[1]),
      "the object's url/name did not become u-url + p-name",
    );
    assert.ok(/\bp-author h-card\b/.test(cite[1]), "the object's author did not become a nested p-author h-card");
    assert.ok(/A Cited Author/.test(cite[1]), "the cited author's name is missing");
    assert.ok(/class="dt-published"/.test(cite[1]), "the object's published date did not become dt-published");
  } finally {
    rmSync(fixture, { force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});



check("the demo builds to its own output directory, never the one the suite reads", () => {
  // This is guarding a real incident, not a hypothetical. `npm run demo` and
  // `demo:serve` once wrote into _site, which is what every check in this file
  // reads. A demo build sitting there fails guards for the right reason and the
  // wrong cause — the feed names the fixture's author instead of the neutral
  // default — and demo:serve's watcher rewrites the directory mid-run, in serve
  // mode, so drafts reappear and critical CSS stops being inlined. Thirteen
  // checks failed at once and none of them were about the change under test.
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  for (const name of ["demo", "demo:serve"]) {
    const script = scripts[name];
    assert.ok(script, `package.json has no "${name}" script`);
    assert.match(
      script,
      /--output=_site-demo\b/,
      `"${name}" does not build to _site-demo — it would overwrite the directory the suite reads`,
    );
    assert.ok(
      script.includes("SITE_FIXTURE=") && script.includes("WEBMENTIONS_FIXTURE="),
      `"${name}" is missing a demo fixture, so it would not show the populated state`,
    );
  }
});



check("every post type has an index listing only its own posts, and the hub counts agree", () => {
  // The indexes live at the same URL segment their posts do (/notes/ lists what
  // /notes/<slug>/ contains), derived in eleventy.config.js from post.url rather
  // than a hand-written singular->plural map — so an index cannot end up
  // pointing somewhere its posts are not. That is the property worth guarding.
  const hub = readFileSync("_site/collections/index.html", "utf8");
  const rows = [...hub.matchAll(
    /<a href="\/([a-z]+)\/">([^<]*)<\/a>\s*<span class="collection-count">(\d+)<\/span>/g,
  )];
  assert.ok(rows.length > 1, "the collections hub lists no post types");

  let sawArchive = false;
  for (const [, segment, , claimed] of rows) {
    const indexPath = `_site/${segment}/index.html`;
    assert.ok(existsSync(indexPath), `the hub links /${segment}/ but no index was built there`);
    const html = readFileSync(indexPath, "utf8");

    const entries = (html.match(/class="h-entry"/g) || []).length;
    assert.equal(
      entries,
      Number(claimed),
      `the hub claims ${claimed} posts for /${segment}/ but that index lists ${entries}`,
    );

    if (segment === "archive") { sawArchive = true; continue; }

    // Only its own type. A listing that silently included everything would
    // still have a plausible count, so check where each row actually links.
    const linked = [...html.matchAll(/<a class="posts-link[^"]*" href="\/([a-z]+)\//g)].map((m) => m[1]);
    assert.ok(linked.length > 0, `/${segment}/ lists no posts at all`);
    const foreign = [...new Set(linked.filter((s) => s !== segment))];
    assert.deepEqual(foreign, [], `/${segment}/ lists posts of other types: ${foreign.join(", ")}`);

    // Every post of that type must appear — an index that lists one of six is
    // worse than none, and the count check alone cannot see it.
    const built = globSync(`_site/${segment}/*/index.html`).length;
    assert.equal(entries, built, `/${segment}/ lists ${entries} posts but ${built} are built`);
  }
  assert.ok(sawArchive, "the hub does not link the full archive");

  // And the hub has to be reachable, or it is a page nobody finds.
  assert.ok(
    readFileSync("_site/index.html", "utf8").includes('href="/collections/"'),
    "nothing links to the collections hub",
  );
});



check("the sitemap lists every indexable page, and only those", () => {
  // The property that matters is completeness, and it is the one that fails
  // silently: a sitemap listing half the site is still well-formed XML. The
  // first attempt here was a template, which saw 13 of 25 pages — every page
  // that consumes collections (the homepage, the per-type indexes,
  // /collections/, the tag pages) was invisible to it. Derive the expected set
  // from the built output, never from the same list the generator used.
  const xml = readFileSync("_site/sitemap.xml", "utf8");
  const site = JSON.parse(readFileSync("_data/site.json", "utf8"));
  const base = site.url.replace(/\/$/, "");

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/, "sitemap has no XML declaration");
  assert.match(
    xml,
    /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/,
    "sitemap is missing the sitemaps.org 0.9 namespace",
  );

  const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length > 0, "sitemap lists no URLs");

  const expected = globSync("_site/**/*.html")
    .filter((f) => !f.startsWith("_site/opengraph/") && !f.endsWith("404.html"))
    .filter((f) => !/<meta name="robots" content="noindex/.test(readFileSync(f, "utf8")))
    .map((f) => `${base}/${f.replace(/^_site\//, "").replace(/index\.html$/, "")}`)
    .sort();

  assert.deepEqual(locs.slice().sort(), expected, "sitemap does not match the set of indexable built pages");

  // Absolute, per the protocol, and under the length cap.
  for (const loc of locs) {
    assert.match(loc, /^https?:\/\//, `sitemap loc is not absolute: ${loc}`);
    assert.ok(loc.length < 2048, `sitemap loc exceeds the 2048-character limit: ${loc}`);
  }
  assert.ok(locs.length <= 50000, "sitemap exceeds the 50,000-URL limit and needs a sitemap index");

  // lastmod: W3C Datetime, only where it means something, and never disagreeing
  // with what the page itself publishes.
  const entries = [...xml.matchAll(/<url>\s*<loc>([^<]*)<\/loc>(?:\s*<lastmod>([^<]*)<\/lastmod>)?\s*<\/url>/g)];
  assert.equal(entries.length, locs.length, "some <url> entries did not parse — check the sitemap's shape");
  let withLastmod = 0;
  for (const [, loc, lastmod] of entries) {
    if (!lastmod) continue;
    withLastmod++;
    assert.match(
      lastmod,
      /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/,
      `lastmod is not W3C Datetime: ${lastmod}`,
    );
    const file = `_site${loc.replace(base, "").replace(/\/$/, "/index.html")}`;
    const published = /dt-published"[^>]*datetime="([^"]*)"/.exec(readFileSync(file, "utf8"));
    assert.ok(published, `${loc} carries lastmod but the page publishes no dt-published`);
    assert.equal(
      Date.parse(lastmod),
      Date.parse(published[1]),
      `${loc}: sitemap lastmod and the page's own dt-published are different instants`,
    );
  }
  assert.ok(withLastmod > 0, "no entry carries lastmod — the date wiring is not exercised");
});

check("robots.txt points at the sitemap and does not block the pages it wants de-indexed", () => {
  const robots = readFileSync("_site/robots.txt", "utf8");
  const site = JSON.parse(readFileSync("_data/site.json", "utf8"));
  const base = site.url.replace(/\/$/, "");

  assert.match(robots, /^User-agent: \*/m, "robots.txt has no User-agent group");
  assert.ok(
    robots.includes(`Sitemap: ${base}/sitemap.xml`),
    `robots.txt does not reference the sitemap at ${base}/sitemap.xml`,
  );
  // Disallowing /opengraph/ would preserve exactly the indexing the noindex on
  // those pages is trying to prevent: a crawler forbidden from fetching a page
  // never reads the noindex inside it.
  assert.ok(
    !/Disallow:\s*\/opengraph/.test(robots),
    "robots.txt disallows /opengraph/, which prevents crawlers from ever seeing its noindex",
  );
});



check("after-hook artifacts are written to the build's real output directory", () => {
  // eleventy.after's `dir.output` reports the directory configured in
  // eleventy.config.js and ignores a CLI `--output=` override; only
  // `directories.output` honours it. Both the sitemap writer and the Pagefind
  // indexer originally used `dir.output`, so every build aimed elsewhere wrote
  // its artifacts into _site: `npm run demo` produced a demo with no search
  // index and no sitemap, and overwrote the ones the test suite reads. Nothing
  // failed loudly — the demo just quietly had no search.
  const outDir = "_site-outputdir-check";
  const sitemapBefore = readFileSync("_site/sitemap.xml");

  try {
    rmSync(outDir, { recursive: true, force: true });
    execFileSync(process.execPath,
      ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
      { stdio: "pipe", env: { ...process.env, NPM_DOWNLOADS_OFFLINE: "1" } });

    assert.ok(existsSync(`${outDir}/sitemap.xml`), "the sitemap was not written into the overridden output directory");
    assert.ok(existsSync(`${outDir}/pagefind`), "the Pagefind index was not written into the overridden output directory");

    // …and the configured directory must be left alone.
    assert.ok(
      readFileSync("_site/sitemap.xml").equals(sitemapBefore),
      "a build aimed at another directory overwrote _site/sitemap.xml",
    );

    // The sitemap must describe the directory it lives in, not another one.
    const locs = [...readFileSync(`${outDir}/sitemap.xml`, "utf8").matchAll(/<loc>([^<]*)<\/loc>/g)]
      .map((m) => m[1]);
    const built = globSync(`${outDir}/**/*.html`)
      .filter((f) => !f.includes("/opengraph/") && !f.endsWith("404.html")).length;
    assert.ok(locs.length > 0, "the overridden build produced an empty sitemap");
    assert.ok(
      Math.abs(locs.length - built) <= 1,
      `sitemap lists ${locs.length} urls but ${built} indexable pages were built into ${outDir}`,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});



check("the JSON Feed is valid 1.1, omits titles on titleless posts, and carries resolvable URLs", () => {
  // JSON Feed 1.1: `version` and `title` are the only required top-level
  // fields, `id` the only required item field. `title` is OPTIONAL on an item
  // and the spec says "Microblog items in particular may omit titles" — which
  // is why this feed does NOT reuse eleventyComputed's synthetic
  // "<Type> · <date>" label the way Atom must (atom:title is required).
  const feed = JSON.parse(readFileSync("_site/feed.json", "utf8"));
  const site = JSON.parse(readFileSync("_data/site.json", "utf8"));
  const base = site.url.replace(/\/$/, "");

  assert.equal(feed.version, "https://jsonfeed.org/version/1.1", "wrong or missing JSON Feed version");
  assert.ok(feed.title, "JSON Feed has no title (required)");
  assert.ok(Array.isArray(feed.items) && feed.items.length > 0, "JSON Feed has no items");
  assert.ok(!("author" in feed), "JSON Feed uses the deprecated singular `author`; 1.1 wants `authors`");

  const titled = new Set(["articles", "bookmarks"]);
  for (const item of feed.items) {
    assert.ok(item.id, "an item has no id (the only required item field)");
    assert.match(item.id, /^https?:\/\//, `item id is not an absolute URL: ${item.id}`);

    const type = item.id.replace(base, "").split("/").filter(Boolean)[0];
    if (titled.has(type)) {
      assert.ok(item.title, `${item.id}: a titled post type carries no title`);
    } else {
      assert.ok(
        !("title" in item),
        `${item.id}: a titleless post type carries a title (${item.title}) — the synthetic label leaked in`,
      );
    }

    // A feed reader has no origin to resolve against, so nothing may stay
    // relative. templateContent is the PRE-transform render and would leave the
    // author's own markdown path here; renderTransforms is what prevents that.
    const relative = [...String(item.content_html || "")
      .matchAll(/(?:src|srcset|href)="((?:\.\.?\/|\/)[^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(relative, [], `${item.id}: content_html has unresolvable relative URLs: ${relative.join(", ")}`);
  }

  // Same posts as Atom — two feeds disagreeing about what was published is
  // worse than one feed.
  const atomIds = [...readFileSync("_site/feed.xml", "utf8").matchAll(/<id>([^<]*)<\/id>/g)]
    .map((m) => m[1]).filter((id) => id !== `${base}/`).sort();
  assert.deepEqual(
    feed.items.map((i) => i.id).sort(),
    atomIds,
    "the JSON Feed and the Atom feed list different posts",
  );

  // Neutral default publishes no authors rather than an empty one.
  assert.ok(!feed.authors, "the neutral default emits an authors array with no configured author");

  // Categories surface as tags where a post has them.
  const tagged = feed.items.filter((i) => Array.isArray(i.tags) && i.tags.length > 0);
  assert.ok(tagged.length > 0, "no item carries tags — the category wiring is not exercised");

  // And the feed has to be discoverable, with the registered media type.
  assert.match(
    readFileSync("_site/index.html", "utf8"),
    /<link rel="alternate" href="\/feed\.json"[^>]*type="application\/feed\+json">/,
    "no JSON Feed auto-discovery link, or the wrong media type",
  );
});



check("p-summary and dt-updated appear only where the post carries that data", () => {
  // Both are CORE h-entry properties. dt-updated is backed by real data:
  // Indiekit writes `updated` on every Micropub edit and preset-eleventy passes
  // it into front matter. The property worth guarding is the ABSENCE case — a
  // "last updated" stamped on every post from build time would look plausible
  // and be a lie about every post that was never edited.
  const article = readFileSync("_site/articles/fixture-article/index.html", "utf8");
  const front = readFileSync("content/articles/fixture-article.md", "utf8");

  const summary = /<p class="p-summary[^"]*">([^<]*)<\/p>/.exec(article);
  assert.ok(summary, "the fixture with a summary emits no p-summary");
  assert.ok(front.includes(summary[1].trim().slice(0, 30)), "p-summary text is not the post's own summary");

  const updated = /<time class="dt-updated" datetime="([^"]*)"/.exec(article);
  assert.ok(updated, "the fixture with an `updated` date emits no dt-updated");
  const declared = /^updated:\s*(\S+)/m.exec(front);
  assert.ok(declared, "the fixture no longer declares `updated` — this check is vacuous");
  assert.equal(
    Date.parse(updated[1]),
    Date.parse(declared[1]),
    "dt-updated is not the same instant as the post's own `updated` value",
  );
  // It must differ from published, or it is not recording an edit.
  const published = /dt-published"[^>]*datetime="([^"]*)"/.exec(article);
  assert.notEqual(Date.parse(updated[1]), Date.parse(published[1]), "dt-updated equals dt-published");

  for (const slug of ["notes/fixture-note", "likes/fixture-like", "replies/fixture-reply"]) {
    const html = readFileSync(`_site/${slug}/index.html`, "utf8");
    assert.ok(!/p-summary/.test(html), `${slug} has no summary but emits p-summary`);
    assert.ok(!/dt-updated/.test(html), `${slug} was never edited but claims dt-updated`);
  }
});

check("Bridgy content classes are opt-in and generated from the configured targets", () => {
  // These name a third-party service. This theme syndicates through Indiekit's
  // own syndicator plugins, which do not read them, so for most sites they are
  // inert vendor markup — hence opt-in, and generated from a list rather than
  // two hardcoded silo names.
  const site = JSON.parse(readFileSync("_data/site.json", "utf8"));
  assert.equal(site.bridgy.enabled, false, "the committed default enables Bridgy classes");
  assert.ok(
    !/e-bridgy-/.test(readFileSync("_site/articles/fixture-article/index.html", "utf8")),
    "Bridgy classes are emitted while disabled",
  );

  const sitePath = "_data/site.json";
  const outDir = "_site-bridgy-check";
  const original = readFileSync(sitePath);
  try {
    const config = JSON.parse(original.toString("utf8"));
    config.bridgy = { enabled: true, targets: ["mastodon", "bluesky"] };
    writeFileSync(sitePath, JSON.stringify(config, null, 2) + "\n");
    rmSync(outDir, { recursive: true, force: true });
    execFileSync(process.execPath,
      ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
      { stdio: "pipe", env: { ...process.env, NPM_DOWNLOADS_OFFLINE: "1" } });

    const html = readFileSync(`${outDir}/articles/fixture-article/index.html`, "utf8");
    const cls = /<p class="(p-summary[^"]*)"/.exec(html);
    assert.ok(cls, "no p-summary element in the opted-in build");
    for (const target of ["mastodon", "bluesky"]) {
      assert.ok(
        cls[1].includes(`e-bridgy-${target}-content`),
        `configured target "${target}" produced no e-bridgy-${target}-content class`,
      );
    }
  } finally {
    writeFileSync(sitePath, original);
    rmSync(outDir, { recursive: true, force: true });
    assert.ok(readFileSync(sitePath).equals(original), "_data/site.json was not restored");
  }
});

check("the footer exposes the machine-readable exits", () => {
  const html = readFileSync("_site/index.html", "utf8");
  const footer = /<div class="footer">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(footer, "no footer rendered");
  for (const [href, label] of [["/feed.xml", "Atom"], ["/feed.json", "JSON Feed"], ["/sitemap.xml", "Sitemap"]]) {
    assert.ok(footer[1].includes(`href="${href}"`), `the footer does not link ${label} (${href})`);
    assert.ok(existsSync(`_site${href}`), `the footer links ${href} but it was not built`);
  }
});



check("JSON-LD uses a type that fits each post, and invents no headlines", () => {
  // schema.org does not require `headline` (checked against
  // schema.org/SocialMediaPosting), so the four titleless Indiekit types carry
  // none. Reusing eleventyComputed's synthetic "<Type> · <date>" label here
  // would reintroduce, in a THIRD representation, the fabrication already
  // removed from p-name and from the JSON Feed — which is the whole reason this
  // is per-type rather than Article-for-everything.
  const expected = {
    // `body: false` for the like is not an omission — a like has no words of its
    // own, only a target. Emitting an empty articleBody for it would be worse
    // than emitting none.
    "articles/fixture-article": { type: "Article", headline: true, shared: false, body: true },
    "notes/fixture-note": { type: "SocialMediaPosting", headline: false, shared: false, body: true },
    "replies/fixture-reply": { type: "SocialMediaPosting", headline: false, shared: true, body: true },
    "likes/fixture-like": { type: "SocialMediaPosting", headline: false, shared: true, body: false },
    "bookmarks/fixture-bookmark": { type: "SocialMediaPosting", headline: true, shared: true, body: true },
    "photos/fixture-photo": { type: "ImageObject", headline: false, shared: false, body: false },
  };

  for (const [slug, want] of Object.entries(expected)) {
    const html = readFileSync(`_site/${slug}/index.html`, "utf8");
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(block, `${slug}: no JSON-LD`);

    // An HTML parser ends a <script> at the first "</script>" anywhere in the
    // text, including inside a JSON string, so no raw "<" may survive.
    assert.ok(!block[1].includes("<"), `${slug}: raw "<" inside the JSON-LD can terminate the script early`);

    const ld = JSON.parse(block[1]);
    assert.equal(ld["@context"], "https://schema.org", `${slug}: wrong @context`);
    assert.equal(ld["@type"], want.type, `${slug}: wrong @type`);
    assert.ok(ld["@id"] && ld.url, `${slug}: JSON-LD has no @id/url`);
    assert.match(ld.url, /^https?:\/\//, `${slug}: JSON-LD url is not absolute`);
    assert.ok(ld.datePublished, `${slug}: no datePublished`);

    assert.equal(
      "headline" in ld,
      want.headline,
      `${slug}: headline presence is wrong — a titleless type must not carry one`,
    );
    if (want.headline) {
      assert.notEqual(
        ld.headline,
        `${ld["@type"]}`,
        `${slug}: headline looks synthesised`,
      );
      assert.ok(!/^\w+ · \d/.test(ld.headline), `${slug}: headline is the synthetic "<Type> · <date>" label`);
    }
    assert.equal("sharedContent" in ld, want.shared, `${slug}: sharedContent presence is wrong`);
    if (want.shared) {
      assert.equal(ld.sharedContent["@type"], "CreativeWork", `${slug}: sharedContent is not a CreativeWork`);
      assert.ok(ld.sharedContent.url, `${slug}: sharedContent has no url`);
    }

    // articleBody belongs to Article-derived types only; ImageObject is not one.
    if (want.type === "ImageObject") {
      assert.ok(!("articleBody" in ld), `${slug}: ImageObject carries articleBody`);
      assert.ok(ld.contentUrl, `${slug}: ImageObject has no contentUrl`);
    } else if (!want.body) {
      assert.ok(
        !("articleBody" in ld),
        `${slug}: a post with no words of its own emits an articleBody`,
      );
    } else {
      assert.ok(ld.articleBody, `${slug}: Article-derived type has no articleBody`);
      assert.ok(
        !/Why the markup matters What Indiekit sends/.test(ld.articleBody),
        `${slug}: the table of contents leaked into articleBody — navigation is not body text`,
      );
      assert.ok(!/<[a-z]/i.test(ld.articleBody), `${slug}: articleBody contains HTML; schema.org expects Text`);
    }
  }
});



// --- design tokens -------------------------------------------------------

// Parse `rgb(12.3%, 4.5%, 67.8%)` / `#rrggbb` into 0..1 channels.
function parseColor(value) {
  const pct = [...String(value).matchAll(/([\d.]+)%/g)].map((m) => Number(m[1]) / 100);
  if (pct.length === 3) return pct;
  const hex = /^#([0-9a-f]{6})$/i.exec(String(value).trim());
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255);
  return null;
}

function wcagContrast(a, b) {
  const lum = (c) => {
    const f = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };
  const [la, lb] = [lum(a), lum(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Read custom properties out of a compiled stylesheet for one selector block
// (default :root), resolving one level of var() indirection. Values from the
// selector block win over :root, so a dark block that says
// `--c-bg: var(--surface-950)` resolves through the ramp declared on :root.
function readTokens(cssPath, selector = ":root") {
  const css = readFileSync(cssPath, "utf8");
  const block = (sel) => {
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([\\s\\S]*?)\\}");
    return re.exec(css);
  };
  const root = block(":root");
  assert.ok(root, `${cssPath}: no :root block — the token layer did not compile`);
  const target = selector === ":root" ? root : block(selector);
  assert.ok(target, `${cssPath}: no ${selector} block`);
  const raw = {};
  for (const src of [root[1], target[1]]) {
    for (const m of src.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) raw[m[1]] = m[2].trim();
  }
  const resolved = {};
  for (const [key, value] of Object.entries(raw)) {
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    resolved[key] = ref ? raw[ref[1]] : value;
  }
  return resolved;
}

check("the token layer emits both ramps and every semantic token", () => {
  const t = readTokens("_site/_css/initial.css");
  for (const step of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
    assert.ok(t[`--accent-${step}`], `--accent-${step} missing from the accent ramp`);
    assert.ok(t[`--surface-${step}`], `--surface-${step} missing from the surface ramp`);
  }
  for (const token of ["--c-bg", "--c-fg", "--c-fg-muted", "--c-heading", "--c-border",
                       "--c-link", "--c-link-hover", "--c-focus",
                       "--c-accent-fill", "--c-accent-fill-fg", "--c-danger"]) {
    assert.ok(t[token], `${token} missing`);
    assert.ok(parseColor(t[token]), `${token} is not a parseable colour: ${t[token]}`);
  }
  // A neutral surface input must produce a genuinely neutral ramp, not one
  // drifting toward the primary's hue.
  const mid = parseColor(t["--surface-500"]);
  assert.ok(
    Math.max(...mid) - Math.min(...mid) < 0.02,
    `--surface-500 is not neutral for a neutral input: ${t["--surface-500"]}`,
  );
});

check("every text token meets WCAG AA and every UI token meets 3:1, recomputed from the emitted CSS", () => {
  // Recomputed from what actually shipped, not from the Sass source — an error
  // in the derivation maths has to fail here rather than reach a reader.
  const t = readTokens("_site/_css/initial.css");
  const bg = parseColor(t["--c-bg"]);
  assert.ok(bg, "--c-bg is not a colour");

  for (const [token, min, kind] of [
    ["--c-fg", 4.5, "body text"],
    ["--c-fg-muted", 4.5, "muted text"],
    ["--c-heading", 4.5, "headings"],
    ["--c-link", 4.5, "links"],
    ["--c-link-hover", 4.5, "link hover"],
    ["--c-danger", 4.5, "error text"],
    ["--c-focus", 3, "focus ring"],
  ]) {
    const ratio = wcagContrast(parseColor(t[token]), bg);
    assert.ok(
      ratio >= min,
      `${token} (${kind}) is ${ratio.toFixed(2)}:1 against --c-bg, below the ${min}:1 floor`,
    );
  }

  // Amber is a fill, never a foreground: it fails 3:1 on a light surface. What
  // sits ON it is what must pass.
  const fill = parseColor(t["--c-accent-fill"]);
  const onFill = parseColor(t["--c-accent-fill-fg"]);
  assert.ok(
    wcagContrast(onFill, fill) >= 4.5,
    `--c-accent-fill-fg is ${wcagContrast(onFill, fill).toFixed(2)}:1 on --c-accent-fill`,
  );
});

check("a primary that fails contrast on its own is clamped to a step that passes", () => {
  // The clamp is the reason a site cannot be configured unreadable. Amber is
  // 2.16:1 on white and near-yellow is worse; both must still yield an AA link.
  const outDir = "_site-contrast-check";
  for (const primary of ["#f0a000", "#ffee00", "#f06f00"]) {
    try {
      rmSync(outDir, { recursive: true, force: true });
      execFileSync(process.execPath,
        ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
        { stdio: "pipe", env: { ...process.env, INDIEKIT_COLOR_PRIMARY: primary, NPM_DOWNLOADS_OFFLINE: "1" } });

      const t = readTokens(`${outDir}/_css/initial.css`);
      const bg = parseColor(t["--c-bg"]);
      const link = wcagContrast(parseColor(t["--c-link"]), bg);
      const focus = wcagContrast(parseColor(t["--c-focus"]), bg);
      assert.ok(link >= 4.5, `primary ${primary}: --c-link is only ${link.toFixed(2)}:1`);
      assert.ok(focus >= 3, `primary ${primary}: --c-focus is only ${focus.toFixed(2)}:1`);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
});

check("INDIEKIT_COLOR_* overrides the committed defaults without editing site.json", () => {
  const sitePath = "_data/site.json";
  const outDir = "_site-colorenv-check";
  const before = readFileSync(sitePath);
  const baseline = readTokens("_site/_css/initial.css")["--accent-500"];
  try {
    rmSync(outDir, { recursive: true, force: true });
    execFileSync(process.execPath,
      ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
      { stdio: "pipe", env: { ...process.env, INDIEKIT_COLOR_PRIMARY: "#0066cc", NPM_DOWNLOADS_OFFLINE: "1" } });

    const overridden = readTokens(`${outDir}/_css/initial.css`)["--accent-500"];
    assert.notEqual(overridden, baseline, "INDIEKIT_COLOR_PRIMARY did not change the accent ramp");
    const [r, g, b] = parseColor(overridden);
    assert.ok(b > r, `the overridden accent is not blue-dominant: ${overridden}`);
    assert.ok(readFileSync(sitePath).equals(before), "_data/site.json was modified by an env-overridden build");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

check("the committed default is the Indiekit brand purple", () => {
  const theme = JSON.parse(readFileSync("_data/site.json", "utf8")).theme;
  assert.equal(theme.primary.toLowerCase(), "#9435f4", "the default primary is no longer the Indiekit purple");
  assert.ok(theme.surface, "no default surface configured");
});



check("no brand colour is hardcoded outside the token layer", () => {
  // The failure this prevents: a literal added to a component stylesheet looks
  // completely normal, compiles, renders — and silently ignores the site's
  // configured palette. It only surfaces when someone reconfigures the colours
  // and one element stays stubbornly the old hue.
  //
  // Three categories are legitimately exempt:
  //   _tokens.scss      — the definitions themselves; this is the source.
  //   syntax palettes   — a code theme encodes language grammar, not brand;
  //                       deriving it from one hue would flatten keywords,
  //                       strings and comments into the same colour.
  //   translucent black — a shadow or scrim is depth, not colour, and tinting
  //                       it with the brand hue makes surfaces look coloured.
  const SYNTAX = /_prism|_syntax-line-highlight|_theme-code/;
  const files = globSync("content/_css/**/*.scss").filter(
    (f) => !f.endsWith("_tokens.scss") && !SYNTAX.test(f),
  );
  assert.ok(files.length > 0, "no stylesheets scanned — this check is vacuous");

  const offenders = [];
  for (const file of files) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;          // comments
      if (/linear-gradient\(238deg/.test(line)) return;      // the literal spectrum
      const hex = line.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
      const rgba = (line.match(/rgba?\([^)]*\)/g) || []).filter(
        (v) => !/^rgba?\(\s*(0\s*,\s*0\s*,\s*0|255\s*,\s*255\s*,\s*255)\b/.test(v),
      );
      for (const found of [...hex, ...rgba]) {
        offenders.push(`${file}:${i + 1} ${found}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `colour literals outside the token layer — these ignore the configured palette:\n  ${offenders.join("\n  ")}`,
  );
});

check("every component colour resolves through a token at runtime", () => {
  // Compiled-CSS counterpart to the source check above: proves the var()
  // references actually resolve, rather than merely being present in the Sass.
  const css = ["_site/_css/initial.css", "_site/_css/defer.css"]
    .map((f) => readFileSync(f, "utf8")).join("\n");
  const declared = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const referenced = [...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
  assert.ok(referenced.length > 20, `only ${referenced.length} var() references — the theme is not token-driven`);

  // Only a BARE var() is a dangling reference. `var(--x, 3)` supplies its own
  // fallback and is valid whether or not --x is declared — several ported
  // layout knobs (--ellipsis-lines, --poster-offset) are deliberately of that
  // shape, set per-component or not at all.
  const withFallback = new Set(
    [...css.matchAll(/var\((--[\w-]+)\s*,/g)].map((m) => m[1]),
  );
  const dangling = [...new Set(referenced)].filter(
    (name) =>
      !declared.has(name) &&
      !withFallback.has(name) &&
      !name.startsWith("--pagefind"),
  );
  assert.deepEqual(dangling, [], `var() references with no declaration: ${dangling.join(", ")}`);
});



check("the space and type scales exist, are used, and do not swallow type-relative spacing", () => {
  // Two spacing systems live here on purpose, and conflating them is the
  // failure this guards. 117 of the theme's spacing values are in `em` and are
  // deliberately type-relative — the port source computes them against local
  // font size and says so ("margin-top: .210526316em; /* 4px /19 */" is 4px at
  // a 19px type size). Those must keep scaling with their component's type. The
  // scale is for LAYOUT spacing, the rem/px values that position chrome and
  // must not move when type changes.
  // All three bundles: opengraph.css is a real stylesheet with its own :root,
  // and omitting it undercounted adoption by a sixth.
  const css = globSync("_site/_css/*.css").map((f) => readFileSync(f, "utf8")).join("\n");

  for (const step of ["3xs", "2xs", "xs", "s", "m", "l", "xl", "2xl", "3xl"]) {
    assert.match(css, new RegExp(`--space-${step}\\s*:`), `--space-${step} is not emitted`);
  }
  for (const step of ["xs", "sm", "base", "lg", "xl"]) {
    assert.match(css, new RegExp(`--text-${step}\\s*:`), `--text-${step} is not emitted`);
  }

  // Emitting a scale nothing uses is the dead-token defect in another costume.
  const spaceUses = (css.match(/var\(--space-/g) || []).length;
  const textUses = (css.match(/var\(--text-/g) || []).length;
  // Floors set just under what the conversion actually produced (21 and 11), so
  // this catches a scale falling out of use rather than asserting a number
  // nobody may add to.
  assert.ok(spaceUses >= 18, `only ${spaceUses} var(--space-*) uses — the scale is declared but not adopted`);
  assert.ok(textUses >= 8, `only ${textUses} var(--text-*) uses — the type scale is declared but not adopted`);

  // And the em system must still be there. If a future sweep "tidies" those
  // into the rem scale, every one of them changes size, and it would look like
  // a refactor rather than a regression.
  const sources = globSync("content/_css/**/*.scss").filter((f) => !f.endsWith("_tokens.scss"));
  const emSpacing = sources
    .map((f) => readFileSync(f, "utf8"))
    .join("\n")
    .match(/(?:margin|padding|gap)[a-z-]*:\s*[^;]*?[0-9.]+em\b/g) || [];
  assert.ok(
    emSpacing.length > 80,
    `only ${emSpacing.length} type-relative em spacing values remain — they were probably converted into the rem scale, which changes all of them`,
  );
});


// --- theme configuration --------------------------------------------------

import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSiteConfig, validateTheme, THEME_DEFAULTS } from "../_11ty/siteConfig.js";

check("every theme key has a shipped default and site.json states it", () => {
  const shipped = JSON.parse(readFileSync("_data/site.json", "utf8")).theme;
  assert.deepEqual(shipped, THEME_DEFAULTS, "_data/site.json theme differs from THEME_DEFAULTS");
  const loaded = loadSiteConfig().theme;
  for (const key of ["primary", "secondary", "surface", "scheme", "shape", "measure"]) {
    assert.ok(loaded[key], `theme.${key} missing after load`);
  }
  for (const key of ["heading", "body", "mono"]) assert.ok(loaded.fonts[key], `theme.fonts.${key} missing`);
  for (const key of ["side", "width"]) assert.ok(loaded.rail[key], `theme.rail.${key} missing`);
  for (const key of ["spectrum", "leader", "anchors"]) {
    assert.equal(typeof loaded.signature[key], "boolean", `theme.signature.${key} is not boolean`);
  }
});

check("an invalid theme value throws naming the key", () => {
  const bad = [
    [{ primary: "purple" }, "theme.primary"],
    [{ surface: "#fff" }, "theme.surface"],
    [{ scheme: "dim" }, "theme.scheme"],
    [{ fonts: { heading: "" } }, "theme.fonts.heading"],
    [{ fonts: { body: "Lato; color: red" } }, "theme.fonts.body"],
    [{ shape: "round" }, "theme.shape"],
    [{ rail: { side: "middle" } }, "theme.rail.side"],
    [{ rail: { width: "wide" } }, "theme.rail.width"],
    [{ measure: "50%" }, "theme.measure"],
    [{ signature: { spectrum: "yes" } }, "theme.signature.spectrum"],
  ];
  for (const [overlay, key] of bad) {
    const merged = structuredClone(THEME_DEFAULTS);
    for (const [k, v] of Object.entries(overlay)) {
      merged[k] = typeof v === "object" ? { ...merged[k], ...v } : v;
    }
    assert.throws(() => validateTheme(merged), (e) => e.message.startsWith(`site.json ${key}:`),
      `${key} did not throw with a message naming it`);
  }
  assert.doesNotThrow(() => validateTheme(THEME_DEFAULTS), "the shipped defaults do not validate");
});

check("a bad theme value fails the build with the key in the message", () => {
  const fixture = join(tmpdir(), `theme-bad-${process.pid}.json`);
  writeFileSync(fixture, JSON.stringify({ theme: { scheme: "dim" } }));
  const outDir = "_site-badtheme-check";
  try {
    rmSync(outDir, { recursive: true, force: true });
    let stderr = "";
    try {
      execFileSync(process.execPath, ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
        { stdio: "pipe", env: { ...process.env, SITE_FIXTURE: fixture, NPM_DOWNLOADS_OFFLINE: "1" } });
      assert.fail("the build succeeded with theme.scheme = dim");
    } catch (error) {
      stderr = String(error.stderr || error.message);
    }
    assert.ok(stderr.includes("theme.scheme"), `build error does not name theme.scheme:\n${stderr.slice(0, 400)}`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(fixture, { force: true });
  }
});

// One build with every knob at its non-default value; each knob then has its
// own assertion against that build. Cheaper than one build per knob and just
// as specific in what it reports.
function buildWithFixture(fixturePath, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  execFileSync(process.execPath, ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
    { stdio: "pipe", env: { ...process.env, SITE_FIXTURE: fixturePath, NPM_DOWNLOADS_OFFLINE: "1" } });
  return {
    outDir,
    tokens: readTokens(`${outDir}/_css/initial.css`),
    html: readFileSync(`${outDir}/index.html`, "utf8"),
    article: readFileSync(`${outDir}/articles/fixture-article/index.html`, "utf8"),
  };
}

const KNOBS_OUT = "_site-knobs-check";
let knobs;
try {
  knobs = buildWithFixture("test/fixtures/theme-knobs.json", KNOBS_OUT);
} catch (error) {
  knobs = null;
  console.log(`FAIL the knob fixture builds — ${String(error.stderr || error.message).slice(0, 300)}`);
  checks.push(false);
}
const defaults = { tokens: readTokens("_site/_css/initial.css"), html: readFileSync("_site/index.html", "utf8") };

check("theme.fonts.* reach the font tokens, with the shipped fallbacks after them", () => {
  assert.ok(knobs, "knob build failed");
  assert.match(knobs.tokens["--font-heading"], /^Georgia, /, `--font-heading: ${knobs.tokens["--font-heading"]}`);
  assert.match(knobs.tokens["--font-body"], /^Verdana, /, `--font-body: ${knobs.tokens["--font-body"]}`);
  assert.match(knobs.tokens["--font-mono"], /^Courier New, /, `--font-mono: ${knobs.tokens["--font-mono"]}`);
  assert.match(defaults.tokens["--font-heading"], /^Hex Franklin Tight, /);
  assert.match(defaults.tokens["--font-body"], /^Lato, /);
});

check("theme.shape sets the radius tokens", () => {
  assert.ok(knobs, "knob build failed");
  assert.equal(defaults.tokens["--radius"], "0");
  assert.equal(defaults.tokens["--radius-avatar"], "0");
  assert.equal(knobs.tokens["--radius"], "0.35em");
  assert.equal(knobs.tokens["--radius-avatar"], "50%");
});

check("theme.rail.width and theme.measure reach their tokens", () => {
  assert.ok(knobs, "knob build failed");
  assert.equal(defaults.tokens["--rail-width"], "14rem");
  assert.equal(defaults.tokens["--measure"], "31em");
  assert.equal(knobs.tokens["--rail-width"], "18rem");
  assert.equal(knobs.tokens["--measure"], "40em");
});

check("theme.signature.leader switches the dotted leader token", () => {
  assert.ok(knobs, "knob build failed");
  assert.equal(defaults.tokens["--leader-border"], "1px dotted var(--c-border)");
  assert.equal(knobs.tokens["--leader-border"], "0");
});

check("no font-family is hard-coded outside the token layer", () => {
  const files = globSync("content/_css/sass/*.scss").filter((f) => !f.endsWith("_tokens.scss") && !f.endsWith("_fonts.scss"));
  const offenders = [];
  for (const file of files) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const m = /font-family\s*:\s*([^;]+);/.exec(line);
      if (!m) return;
      const value = m[1].trim();
      if (value === "inherit" || /^var\(--font-/.test(value)) return;
      // _disqus.scss's Comic Sans is a joke rule on the "static-comments" empty
      // state, ported verbatim; it is not a theme face.
      if (file.endsWith("_disqus.scss") && /Comic Sans/.test(value)) return;
      offenders.push(`${file}:${i + 1} ${value}`);
    });
  }
  assert.deepEqual(offenders, [], `font-family literals bypass the font tokens:\n  ${offenders.join("\n  ")}`);
});

check("every border-radius reads a radius token", () => {
  const files = globSync("content/_css/sass/*.scss").filter((f) => !f.endsWith("_tokens.scss"));
  const offenders = [];
  for (const file of files) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const m = /border-radius\s*:\s*([^;]+);/.exec(line);
      if (m && !/^(0|var\(--radius(-avatar)?\)|var\(--radius\) var\(--radius\) 0 0)$/.test(m[1].trim())) {
        offenders.push(`${file}:${i + 1} ${m[1].trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `border-radius literals bypass theme.shape:\n  ${offenders.join("\n  ")}`);
  // And the reset is gone: a rounded site must actually round.
  const css = readFileSync(`${KNOBS_OUT}/_css/initial.css`, "utf8") + readFileSync(`${KNOBS_OUT}/_css/defer.css`, "utf8");
  assert.ok(!/body :not\(\[class\*="pagefind"\]\)/.test(css), "the global border-radius:0 reset is still emitted");
});

check("theme.rail.side, theme.scheme and the heading-font state are written on <html>", () => {
  assert.ok(knobs, "knob build failed");
  assert.match(defaults.html, /<html[^>]* data-rail="end"/);
  assert.match(defaults.html, /<html[^>]* data-scheme="auto"/);
  assert.match(defaults.html, /<html[^>]* data-heading-font="default"/);
  assert.match(knobs.html, /<html[^>]* data-rail="start"/);
  assert.match(knobs.html, /<html[^>]* data-scheme="dark"/);
  assert.match(knobs.html, /<html[^>]* data-heading-font="custom"/);
});

check("the grid reads --rail-width and --measure, and rail=start swaps the columns", () => {
  const css = readFileSync("_site/_css/initial.css", "utf8");
  assert.match(css, /grid-template-columns:\s*1fr var\(--rail-width\) 2\.5rem/, "default grid does not read --rail-width");
  assert.match(css, /minmax\(auto, var\(--measure\)\)/, "content grid does not read --measure");
  assert.match(css, /max-width:\s*var\(--measure\)/, "content-grid-sibling does not read --measure");
  assert.match(css, /html\[data-rail=start\][^{]*\.body-grid\s*\{[^}]*grid-template-columns:\s*2\.5rem var\(--rail-width\) 1fr/, "no start-side grid");
  // Excludes the --measure custom-property declaration itself: that line IS
  // the token's source value (site.json's default), not a rule that bypassed
  // var(--measure). Every other occurrence would be a leak.
  const cssWithoutTokenDecl = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--measure:\s*31em;/, "");
  assert.ok(!/\b31em\b/.test(cssWithoutTokenDecl), "a literal 31em survives in the compiled CSS outside the --measure declaration");
});

check("the dark scheme is emitted for auto and forced, and every dark token meets its ratio", () => {
  const css = readFileSync("_site/_css/initial.css", "utf8");
  assert.match(css, /@media \(prefers-color-scheme: dark\)\s*\{\s*html\[data-scheme=auto\]/, "no auto dark block");
  assert.match(css, /color-scheme:\s*light dark/, ":root does not declare color-scheme");

  const t = readTokens("_site/_css/initial.css", 'html[data-scheme=dark]');
  const bg = parseColor(t["--c-bg"]);
  assert.ok(bg, `dark --c-bg is not a colour: ${t["--c-bg"]}`);
  assert.ok(Math.max(...bg) < 0.25, `dark --c-bg is not dark: ${t["--c-bg"]}`);
  for (const [token, min] of [
    ["--c-fg", 4.5], ["--c-fg-muted", 4.5], ["--c-heading", 4.5], ["--c-link", 4.5],
    ["--c-link-hover", 4.5], ["--c-link-visited", 4.5], ["--c-danger", 4.5], ["--c-focus", 3],
  ]) {
    const ratio = wcagContrast(parseColor(t[token]), bg);
    assert.ok(ratio >= min, `dark ${token} is ${ratio.toFixed(2)}:1 against --c-bg, below ${min}:1`);
  }
  const fill = parseColor(t["--c-accent-fill"]);
  const onFill = parseColor(t["--c-accent-fill-fg"]);
  assert.ok(wcagContrast(onFill, fill) >= 4.5, `dark --c-accent-fill-fg is ${wcagContrast(onFill, fill).toFixed(2)}:1 on its fill`);
  for (const token of ["--rail-bg", "--footer-bg", "--card-bg", "--c-highlight", "--c-border", "--c-on-accent"]) {
    assert.ok(parseColor(t[token]), `dark ${token} missing or not a colour: ${t[token]}`);
  }
});

check("theme.signature.spectrum and .anchors gate their markup; leader and heading case follow their tokens", () => {
  assert.ok(knobs, "knob build failed");
  assert.match(defaults.html, /<html[^>]* class="[^"]*page-gradient/, "default has no spectrum class");
  assert.ok(!/page-gradient/.test(knobs.html), "spectrum=false still emits page-gradient");
  assert.match(defaults.html, /<script src="\/heading-anchors\.js" type="module">/, "default does not load heading-anchors");
  assert.ok(!/heading-anchors\.js/.test(knobs.html), "anchors=false still loads heading-anchors.js");

  const css = readFileSync("_site/_css/initial.css", "utf8");
  assert.match(css, /border-bottom:\s*var\(--leader-border\)/, "the leader does not read --leader-border");
  assert.match(css, /html\[data-heading-font=default\][^{]*\{[^}]*text-transform:\s*uppercase/, "heading uppercase is not scoped to the default font");
  assert.match(css, /html\[data-heading-font=default\][^{]*\{[^}]*font-variation-settings/, "variation axes are not scoped to the default font");
  const unscoped = css.replace(/html\[data-heading-font=default\][^{]*\{[^}]*\}/g, "");
  assert.ok(!/font-variation-settings/.test(unscoped), "a font-variation-settings rule is still unscoped");
});

rmSync(KNOBS_OUT, { recursive: true, force: true });

const failed = checks.filter((c) => !c).length;
const passed = checks.length - failed;
const skipNote = skipped ? `, ${skipped} skipped` : "";
console.log(`\n${passed}/${checks.length} checks passed${skipNote}`);
process.exit(failed === 0 ? 0 : 1);
