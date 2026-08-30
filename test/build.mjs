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
  const html = readFileSync("_site/index.html", "utf8");
  assert.ok(!html.includes("zachleat"), "found a zachleat reference in output");
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
  assert.ok(html.includes("/media/sample.png"), "photo src missing");
});

const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
