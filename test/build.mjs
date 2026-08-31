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
const imagePlugin = await import("./_11ty/imagePlugin.js");

process.stdout.write("\\nPROBE_RESULT:" + JSON.stringify({
  webmentions: webmentions.default.CACHE_DURATION,
  npmDownloads: npmDownloads.default.CACHE_DURATION,
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
      // renders on every page) by a marker unique to initial.scss's
      // compiled output — a CSS custom property from sass/_config.scss,
      // pulled in transitively by every partial initial.scss @uses, and
      // absent from defer.css.
      const criticalMarker = "--z-border-radius-1";
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
  assert.ok(!feed.includes("MARKER_draft_note"), "draft note's marker leaked into feed.xml");
  const homepage = readFileSync("_site/index.html", "utf8");
  assert.ok(!homepage.includes("MARKER_draft_note"), "draft note's marker leaked into the h-feed homepage listing");
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
    assert.ok(feed.includes("MARKER_draft_note"), "draft note's marker is missing from feed.xml under serve mode");
    const homepage = readFileSync(`${outDir}/index.html`, "utf8");
    assert.ok(
      homepage.includes("MARKER_draft_note"),
      "draft note's marker is missing from the h-feed homepage listing under serve mode",
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
  const files = globSync("_site/**/*.html");
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
  const files = globSync("_site/**/*.html");
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
  const css = globSync("_site/**/*.css").map((f) => readFileSync(f, "utf8")).join("");
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
  const css = globSync("_site/**/*.css").map((f) => readFileSync(f, "utf8")).join("");
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

      const buildHtml = readFileSync(`${buildOutDir}/index.html`, "utf8");
      const serveHtml = readFileSync(`${serveOutDir}/index.html`, "utf8");

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
// through (/static/defer.css, the toggle-button asset paths, now this); the
// last check asserts every same-origin <script src> / <link
// rel="stylesheet" href> on every built page resolves to a real file.
check("heading-anchors wraps the real e-content body in every post type that has one", () => {
  // Confirms the markup wiring, not just that the module file exists: a
  // <script src> that resolves to a real file which is never applied to any
  // heading would still pass every check above. Source (page.liquid:9-11,
  // post.liquid:55-57) wraps its content div's body in
  // <heading-anchors selector="h2,h3"> — h2,h3 because h1 is reserved for
  // the page/post title (this partial's own <h1 class="p-name">), so body
  // content headings start at h2. "like" has no e-content div (its body is
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

check("every same-origin script src and stylesheet href emitted by any built page resolves to a real file in _site", () => {
  // Scoped to same-origin absolute paths (starts with "/", not "//") —
  // external URLs (https://…) and data: URIs are never built by this theme
  // and are out of scope. Scans every built .html page, not just index.html
  // (the pre-existing "the page links a stylesheet that actually exists"
  // check above only covers index.html and would have missed this bug,
  // which only reached the six post-type permalink pages after Task 18
  // routed them through default.liquid).
  //
  // One known, pre-existing exception: /static/infinity-burger.js
  // (default.liquid's decorative "hamburger" easter egg). Verified against
  // task-13-report.md and the port source itself: this reference is broken
  // even in /home/rmdes/zachleat.com's own checkout — no infinity-burger.js
  // exists there either, so there is no source file to port and this is not
  // a regression this theme introduced. Task 13 deliberately left it
  // unmodified as out of scope; fixing it now would be scope creep on a
  // finding about two specific, different, and now-fixed module paths. It
  // is exempted BY PATH — see the attributionExempt pattern above — rather
  // than by weakening the check, so the exemption is auditable and a NEW
  // dead reference elsewhere still fails this check.
  const referenceExempt = new Set(["/static/infinity-burger.js"]);

  const files = globSync("_site/**/*.html");
  assert.ok(files.length > 0, "no HTML built — this check scanned nothing");

  let scriptCount = 0;
  let stylesheetCount = 0;
  const seenExempt = new Set();

  for (const file of files) {
    const html = readFileSync(file, "utf8");

    const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"[^>]*>/g)].map((m) => m[1]);
    const stylesheetHrefs = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)]
      .map((m) => m[0].match(/href="([^"]+)"/)?.[1])
      .filter(Boolean);

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
  }

  // Non-vacuous: a change that stopped this check from finding any scripts
  // or stylesheets at all must fail loudly, not pass by having nothing left
  // to inspect.
  assert.ok(scriptCount > 0, "no same-origin scripts found across any built page — this check is vacuous");
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
    // The --glob value is extracted from package.json's own "search-index"
    // script rather than hardcoded a second time here — a hardcoded copy
    // would let this check keep passing even if package.json's script
    // regressed to an unscoped (or differently-scoped) glob, since nothing
    // would ever exercise the real script string. Confirmed by hand: with a
    // hardcoded glob, reverting package.json's script to the old unscoped
    // "npx pagefind --site _site" left this check green.
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const searchIndexScript = packageJson.scripts["search-index"];
    const globMatch = /--glob\s+"([^"]+)"/.exec(searchIndexScript);
    assert.ok(
      globMatch,
      `package.json's "search-index" script has no --glob argument to scope the index: ${searchIndexScript}`,
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

const failed = checks.filter((c) => !c).length;
const passed = checks.length - failed;
const skipNote = skipped ? `, ${skipped} skipped` : "";
console.log(`\n${passed}/${checks.length} checks passed${skipNote}`);
process.exit(failed === 0 ? 0 : 1);
