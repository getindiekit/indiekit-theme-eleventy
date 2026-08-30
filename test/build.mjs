import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync, rmSync, globSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

check("npm downloads data is available and numeric", () => {
  // A bare regex on "downloads: <number>" passes identically whether the
  // fetch worked (a real count) or silently failed (0) — it can't tell a
  // live feature from a dead one. NPM_DOWNLOADS_OFFLINE is the one case
  // where 0 is the *correct* answer (CI has no network), so the assertion
  // has to know which mode it's in rather than accept any integer.
  const html = readFileSync("_site/index.html", "utf8");
  const match = /downloads:\s*(-?\d+)/.exec(html);
  assert.ok(match, "download count not rendered");
  const value = Number(match[1]);
  if (process.env.NPM_DOWNLOADS_OFFLINE) {
    assert.equal(value, 0, `offline mode must render exactly 0, got ${value}`);
  } else {
    assert.ok(
      Number.isInteger(value) && value > 0,
      `expected a positive rendered download count, got ${value}`,
    );
  }
});

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

check("compiles sass to css", () => {
  const css = globSync("_site/**/*.css");
  assert.ok(css.length > 0, "no .css file produced in _site");
});

check("image transform plugin produces optimised output", () => {
  const html = readFileSync("_site/index.html", "utf8");

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
  const extensions = { html: "_site/**/*.html", js: "_site/**/*.js", css: "_site/**/*.css" };
  for (const [ext, glob] of Object.entries(extensions)) {
    const files = globSync(glob);
    assert.ok(files.length > 0, `no .${ext} produced in _site — this check scanned nothing for that type`);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      assert.ok(!text.includes("zachleat"), `found a zachleat reference in ${file}`);
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
    // Three throwaway fixtures at content root, same pattern as the
    // toggle-button WebC check above: a tagged "member" page, a listing
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
});

check("navigation styling ships, with no animation", () => {
  const css = globSync("_site/**/*.css").map((f) => readFileSync(f, "utf8")).join("");
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
    const files = globSync(`_site/${type}/**/index.html`);
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

check("the homepage is an h-feed listing every post", () => {
  // Task 12a: found during Task 12 — the theme built 8 pages and the
  // homepage linked to none of them. This asserts every post type is
  // represented, so a listing that silently drops the titleless types
  // (note/bookmark/like/reply — the majority of Indiekit's post types)
  // fails, not just a listing that shows articles alone.
  const html = readFileSync("_site/index.html", "utf8");
  assert.ok(/class="[^"]*\bh-feed\b/.test(html), "homepage is not marked up as an h-feed");
  for (const type of ["articles", "notes", "bookmarks", "likes", "replies", "photos"]) {
    assert.ok(
      new RegExp(`href="/${type}/[^"]+/"`).test(html),
      `homepage h-feed has no entry linking into /${type}/`,
    );
  }
});

check("h-feed entries carry h-entry, not bare links", () => {
  // The check above would also pass if the listing were a plain <a> list
  // with no microformats at all — assert each entry is itself a valid
  // h-entry, one per post-tagged fixture (7: see the feed entry-count
  // check above for why it's 7, not 6).
  const html = readFileSync("_site/index.html", "utf8");
  const entryCount = (html.match(/class="h-entry"/g) || []).length;
  assert.equal(entryCount, 7, `expected 7 h-entry listing entries, found ${entryCount}`);
});

check("h-feed lists posts newest first", () => {
  // Would pass trivially if the listing were unordered and happened to
  // match — compare the actual href order against fixture dates sorted
  // descending, not just "some order exists".
  const html = readFileSync("_site/index.html", "utf8");
  const feedSection = html.split(/class="[^"]*\bh-feed\b[^"]*"/)[1] ?? "";
  const hrefs = [...feedSection.matchAll(/href="(\/(?:articles|notes|bookmarks|likes|replies|photos)\/[^"]+\/)"/g)]
    .map((m) => m[1]);
  assert.equal(hrefs.length, 7, `expected 7 entry links inside the h-feed, found ${hrefs.length}`);

  const fixtures = [
    ["articles", "fixture-article"],
    ["notes", "fixture-note"],
    ["bookmarks", "fixture-bookmark"],
    ["bookmarks", "fixture-untitled-bookmark"],
    ["likes", "fixture-like"],
    ["replies", "fixture-reply"],
    ["photos", "fixture-photo"],
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

check("h-feed entry dates match the same instant as the post's own page", () => {
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
  const html = readFileSync("_site/index.html", "utf8");
  const fixtures = [
    ["articles", "fixture-article"],
    ["notes", "fixture-note"],
    ["bookmarks", "fixture-bookmark"],
    ["bookmarks", "fixture-untitled-bookmark"],
    ["likes", "fixture-like"],
    ["replies", "fixture-reply"],
    ["photos", "fixture-photo"],
  ];
  for (const [type, slug] of fixtures) {
    const pageHtml = readFileSync(`_site/${type}/${slug}/index.html`, "utf8");
    const pageMatch = pageHtml.match(/dt-published" datetime="([^"]*)"/);
    assert.ok(pageMatch, `${type}/${slug}: page has no dt-published datetime attribute`);

    const entry = html.split(`href="/${type}/${slug}/"`)[0].split(/<li/).pop() +
      `href="/${type}/${slug}/"` +
      html.split(`href="/${type}/${slug}/"`)[1].split(/<\/li>/)[0];
    const listingMatch = entry.match(/dt-published" datetime="([^"]*)"/);
    assert.ok(listingMatch, `${type}/${slug}: no dt-published datetime attribute in its h-feed entry`);
    assert.equal(
      Date.parse(listingMatch[1]),
      Date.parse(pageMatch[1]),
      `${type}/${slug}: h-feed entry datetime "${listingMatch[1]}" is not the same instant as the page's "${pageMatch[1]}"`,
    );
  }
});

// Extracts the full source text of every top-level `<article class="h-entry">
// ...</article>` block from an HTML string, respecting nesting. The four
// checks above are all regex/string matches over flat HTML — none of them
// can tell whether a `u-url` anchor is a property of an h-entry or merely
// somewhere else on the same page (this is exactly how the h-feed permalink
// bug shipped with a green suite: the anchor sat as a sibling *before* each
// <article>, and every flat check still matched). A naive non-greedy scan
// (`/<article[^>]*>.*?<\/article>/gs`) would also mismatch here: nothing in
// this file's <article> markup nests another <article>, but relying on that
// silently is how "a check that matches the wrong span" (this project's own
// stated failure mode) gets written — so this walks open/close tags with an
// explicit depth counter instead of trusting non-greedy regex to stop at the
// right boundary.
function extractHEntryBlocks(html) {
  const tagRe = /<article\b[^>]*>|<\/article>/g;
  const blocks = [];
  let openStart = -1;
  let depth = 0;
  let match;
  while ((match = tagRe.exec(html))) {
    const isOpen = match[0].startsWith("<article");
    if (isOpen) {
      if (depth === 0) {
        openStart = match.index;
        // Only h-entry-classed <article> opens are collected — a plain
        // <article> with no h-entry class (none exist in this theme today,
        // but the check should not silently start counting one if it ever
        // does) is tracked for depth only, not returned as a block.
      }
      depth++;
    } else {
      depth--;
      if (depth === 0 && openStart !== -1) {
        const block = html.slice(openStart, match.index + match[0].length);
        if (/^<article class="h-entry"/.test(block)) {
          blocks.push(block);
        }
        openStart = -1;
      }
    }
  }
  return blocks;
}

check("every h-entry in the homepage listing carries its own u-url", () => {
  // The bug this guards against: the permalink <a class="u-url"> rendered
  // as a sibling *before* each <article class="h-entry">, not inside it. A
  // real mf2 parser confirmed the consequence — all 7 permalinks collapsed
  // onto the h-feed root's `url` property and every h-entry child had none.
  // Flat regex/string checks (the four `h-feed ...` checks above) cannot
  // see this: they all matched a `u-url` and an `h-entry` existing
  // *somewhere* on the page, never whether one is nested inside the other.
  const html = readFileSync("_site/index.html", "utf8");
  const blocks = extractHEntryBlocks(html);

  // Guards against the "scan matching no files passes forever" false-green
  // pattern: if the extractor's boundary logic were broken and found zero
  // blocks, `blocks.every(...)` below would vacuously pass on an empty
  // array. Pin the count to the known fixture total (see "h-feed entries
  // carry h-entry" above for why it's 7) so a broken extractor fails loudly
  // instead of silently checking nothing.
  assert.equal(blocks.length, 7, `expected 7 h-entry blocks, found ${blocks.length}`);

  const missing = blocks
    .map((block, i) => ({ i, hasUrl: /\bu-url\b/.test(block) }))
    .filter((b) => !b.hasUrl);
  assert.equal(
    missing.length,
    0,
    `${missing.length} of ${blocks.length} h-entry blocks have no u-url within their own boundaries (indices: ${missing.map((m) => m.i).join(", ")})`,
  );
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

check("speedlify is absent when disabled", () => {
  const html = readFileSync("_site/index.html", "utf8");
  assert.ok(!html.includes("speedlify2-score"), "element rendered while disabled");
});

check("speedlify renders with the configured url on every page when enabled", () => {
  // The disabled-state check above only proves the widget can be hidden — it
  // would still pass if the whole integration were deleted. Build a second,
  // throwaway output with speedlify turned on and assert the widget actually
  // renders, carrying the real configured url, everywhere the layout puts it.
  const sitePath = "_data/site.json";
  const outDir = "_site-speedlify-check";
  const testUrl = "https://speedlify.example/api";
  const original = readFileSync(sitePath);

  try {
    const config = JSON.parse(original.toString("utf8"));
    config.speedlify = { url: testUrl, enabled: true };
    writeFileSync(sitePath, JSON.stringify(config, null, 2) + "\n");

    rmSync(outDir, { recursive: true, force: true });
    execFileSync(
      process.execPath,
      ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
      { stdio: "pipe" },
    );

    const files = globSync(`${outDir}/**/*.html`);
    assert.ok(files.length > 0, "no HTML produced for the speedlify-enabled build");
    for (const file of files) {
      const html = readFileSync(file, "utf8");
      assert.ok(
        html.includes(`<speedlify2-score theme="light" speedlify-url="${testUrl}"`),
        `speedlify widget missing or url does not match configured value in ${file}`,
      );
      assert.ok(
        html.includes('<script type="module" src="/js/speedlify2-score.js"></script>'),
        `speedlify script tag missing in ${file}`,
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
  // this plugin's `collection.name: "post"` option. 7, not 6: Task 11 added a
  // second bookmark fixture (fixture-untitled-bookmark.md) to exercise the
  // titleless-bookmark fallback.
  const xml = readFileSync("_site/feed.xml", "utf8");
  const entryCount = (xml.match(/<entry>/g) || []).length;
  assert.equal(entryCount, 7, `expected 7 feed entries (one per post-type fixture, plus the untitled-bookmark fixture), got ${entryCount}`);
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
  // types produce no title of their own. 7, not 6: see the entry-count
  // check above.
  const xml = readFileSync("_site/feed.xml", "utf8");
  const titles = [...xml.matchAll(/<title>([\s\S]*?)<\/title>/g)]
    .map((m) => m[1].trim())
    // the feed's own <title> (site name) is not an entry title
    .slice(1);
  assert.equal(titles.length, 7, `expected 7 entry titles, found ${titles.length}`);
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

check("no .webc source template is published into _site", () => {
  // addPassthroughCopy({ _components: "/" }) previously copied the whole
  // _components dir verbatim, shipping .webc build-input templates (e.g.
  // toggle-button.webc) into the output tree alongside real assets.
  const files = globSync("_site/**/*.webc");
  assert.equal(files.length, 0, `.webc file(s) published into _site: ${files.join(", ")}`);
});

check("toggle-button's own CSS/JS assets are reachable at the paths it links", () => {
  // toggle-button.webc links /toggle-button.css and /toggle-button.js. The
  // old passthrough shipped _components/* under /static/ paths that don't
  // match what the component actually references — both 404'd.
  const webc = readFileSync("_components/toggle-button.webc", "utf8");
  const hrefs = [...webc.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 0, "toggle-button.webc links no assets to check");
  for (const href of hrefs) {
    assert.ok(existsSync(`_site${href}`), `toggle-button.webc links ${href}, which does not exist in _site`);
  }
});

await checkAsync("toggle-button WebC component resolves through the build", async () => {
  // pluginWebc's `components` glob only expands custom-element tags inside
  // .webc templates (useTransform defaults to false, and this theme doesn't
  // set it) — no .liquid/.md page in this theme invokes <toggle-button>, so
  // there is nothing in the real _site build that would fail if the plugin
  // were unregistered or pointed at the wrong glob. Build one throwaway .webc
  // page that uses the component and confirm it actually expands, following
  // the same patch-and-restore-in-finally pattern as the speedlify check
  // above.
  const fixturePath = "content/_webc-check.webc";
  const outDir = "_site-webc-check";
  const marker = "WEBC_CHECK_MARKER";
  // No explicit permalink: WebC front matter treats a literal permalink
  // string as a dynamic expression here and eleventy rejects the resulting
  // object, so rely on the default input-path-derived output location.
  const fixture = `---
eleventyExcludeFromCollections: true
---
<toggle-button label="${marker}"></toggle-button>
`;

  writeFileSync(fixturePath, fixture);
  try {
    rmSync(outDir, { recursive: true, force: true });
    execFileSync(
      process.execPath,
      ["node_modules/.bin/eleventy", `--output=${outDir}`, "--quiet"],
      { stdio: "pipe" },
    );

    const outFile = `${outDir}/_webc-check/index.html`;
    assert.ok(existsSync(outFile), `${outFile} was not built — .webc is not a recognised template format`);
    const html = readFileSync(outFile, "utf8");
    assert.ok(
      html.includes("toggle-island"),
      "<toggle-button> did not expand into its component markup — _components/**/*.webc is not resolving",
    );
    assert.ok(html.includes(marker), "toggle-button's label attribute did not render");
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

const failed = checks.filter((c) => !c).length;
const passed = checks.length - failed;
const skipNote = skipped ? `, ${skipped} skipped` : "";
console.log(`\n${passed}/${checks.length} checks passed${skipNote}`);
process.exit(failed === 0 ? 0 : 1);
