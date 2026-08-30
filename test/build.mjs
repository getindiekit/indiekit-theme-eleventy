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

const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
