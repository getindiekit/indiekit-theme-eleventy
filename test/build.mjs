import { strict as assert } from "node:assert";
import { existsSync, readFileSync, globSync } from "node:fs";

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
