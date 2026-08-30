import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync, rmSync, globSync } from "node:fs";
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
  const files = globSync("_site/**/*.html");
  assert.ok(files.length > 0, "no HTML produced in _site");
  for (const file of files) {
    const html = readFileSync(file, "utf8");
    assert.ok(!html.includes("zachleat"), `found a zachleat reference in ${file}`);
  }
});

check("templates reading collections declare eleventyImport", () => {
  // A template that reads collections.* without declaring
  // `eleventyImport: { collections: [...] }` in its own front matter (or
  // inherits it from its layout chain) will not be rebuilt by `--incremental`
  // when a collection member changes elsewhere — a silent stale-listing bug,
  // not something a build-output assertion can see. Source-scan instead.
  const files = globSync("{content,_includes}/**/*.{liquid,md,njk,html}");
  assert.ok(
    files.length > 0,
    "glob matched no template files — this check scanned nothing",
  );

  const isOffender = (src) => /collections\./.test(src) && !/eleventyImport/.test(src);

  // This repo currently has zero templates that read collections.* at all
  // (verified: `grep -rn 'collections\.' content/ _includes/` — no hits).
  // That makes the real scan below pass with 0 offenders for a reason that
  // proves nothing: "no violations" and "nothing to violate" look identical
  // from offenders.length alone. Exercise the same detector against inline
  // fixtures first, so a pass is backed by evidence the detector actually
  // distinguishes an offender from a compliant or irrelevant file — not
  // just an empty result set.
  assert.equal(
    isOffender('{% for p in collections.post %}{% endfor %}'),
    true,
    "detector failed to flag a template reading collections.* with no eleventyImport",
  );
  assert.equal(
    isOffender(
      '---\neleventyImport:\n  collections: ["post"]\n---\n{% for p in collections.post %}{% endfor %}',
    ),
    false,
    "detector flagged a template that already declares eleventyImport",
  );
  assert.equal(
    isOffender("<p>no collections read here</p>"),
    false,
    "detector flagged a template that never reads collections.*",
  );

  const offenders = files.filter((f) => isOffender(readFileSync(f, "utf8")));
  assert.equal(
    offenders.length,
    0,
    `templates read collections.* without declaring eleventyImport: ${offenders.join(", ")}`,
  );
});

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
