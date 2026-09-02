import { readFileSync } from "node:fs";

/**
 * Site configuration, with an optional overlay.
 *
 * `_data/site.json` is the neutral default and stays the source of truth. When
 * SITE_FIXTURE names a JSON file, its values are deep-merged over that default.
 *
 * WHY: the theme ships neutral, so everything identity-shaped — the h-card, the
 * rel=me links, the feed author — renders as nothing on a fresh checkout. That
 * is correct, and it also makes those parts impossible to preview, review or
 * restyle. `npm run demo` supplies a fixture so the populated state can be seen
 * without editing a tracked file, which is the same reason the webmention demo
 * fixture exists.
 *
 * Six modules read site config (eleventy.config.js, _data/eleventyComputed.js,
 * _data/speedlify.js, _data/webmentions.js, _11ty/imagePlugin.js,
 * _11ty/webmentionsPlugin.js). They all go through here so the overlay cannot
 * apply to some of them and not others — a half-overlaid build would render an
 * h-card for one identity and a feed author for another.
 *
 * Templates receive it through _data/eleventyComputed.js's computed `site`:
 * computed data is the only tier that outranks a `_data/*` global, so replacing
 * `site` there is what makes the overlay visible to markup at all.
 */

/** Deep-merge plain objects; arrays and scalars are replaced wholesale. */
function merge(base, overlay) {
	const out = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		const isPlainObject = (v) =>
			v !== null && typeof v === "object" && !Array.isArray(v);
		out[key] =
			isPlainObject(value) && isPlainObject(base[key])
				? merge(base[key], value)
				: value;
	}
	return out;
}

let cached;

export function loadSiteConfig() {
	if (cached) {
		return cached;
	}
	const base = JSON.parse(
		readFileSync(new URL("../_data/site.json", import.meta.url), "utf8"),
	);
	cached = process.env.SITE_FIXTURE
		? merge(base, JSON.parse(readFileSync(process.env.SITE_FIXTURE, "utf8")))
		: base;

	// Colour inputs may also come from the environment, which is how an Indiekit
	// deployment sets them without editing a tracked file. Same precedence as
	// everything else here: the JSON file is the source, the environment
	// overlays it. Only these two are read — every other token is derived, so
	// there is nothing else to override.
	const envColors = {
		primary: process.env.INDIEKIT_COLOR_PRIMARY,
		surface: process.env.INDIEKIT_COLOR_SURFACE,
	};
	for (const [key, value] of Object.entries(envColors)) {
		if (value) {
			cached = merge(cached, { theme: { [key]: value } });
		}
	}

	return cached;
}

export default loadSiteConfig;
