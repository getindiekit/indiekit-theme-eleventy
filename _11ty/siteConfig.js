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

// Every theme key with its shipped value. site.json states the same values so
// a reader sees them; this is what guarantees an OMITTED key never breaks a
// build. A test asserts the two stay identical.
export const THEME_DEFAULTS = Object.freeze({
	primary: "#9435f4",
	secondary: "#f0a000",
	surface: "#ffffff",
	scheme: "auto",
	schemeToggle: true,
	fonts: {
		heading: "Hex Franklin Tight",
		body: "Lato",
		mono: "Consolas, Monaco, monospace",
	},
	shape: "sharp",
	rail: { side: "end", width: "14rem" },
	measure: "31em",
	signature: { spectrum: true, leader: true, anchors: true },
});

const HEX = /^#[0-9a-f]{6}$/i;
const LENGTH = /^\d+(\.\d+)?(rem|em|px|ch)$/;

function fail(key, reason) {
	throw new Error(`site.json theme.${key}: ${reason}`);
}

// Fail the build, name the key. The audience edits JSON and never CSS, so a
// silent fallback would hide the one mistake they can actually fix.
export function validateTheme(theme) {
	for (const key of ["primary", "secondary", "surface"]) {
		if (!HEX.test(theme[key])) fail(key, `expected a six-digit hex colour like #9435f4, got ${JSON.stringify(theme[key])}`);
	}
	if (!["light", "dark", "auto"].includes(theme.scheme)) fail("scheme", `expected light, dark or auto, got ${JSON.stringify(theme.scheme)}`);
	if (typeof theme.schemeToggle !== "boolean") fail("schemeToggle", `expected true or false, got ${JSON.stringify(theme.schemeToggle)}`);
	for (const key of ["heading", "body", "mono"]) {
		const value = theme.fonts?.[key];
		if (typeof value !== "string" || value.trim() === "" || /[;}]/.test(value)) {
			fail(`fonts.${key}`, `expected a font-family list without ; or }, got ${JSON.stringify(value)}`);
		}
	}
	if (!["sharp", "rounded"].includes(theme.shape)) fail("shape", `expected sharp or rounded, got ${JSON.stringify(theme.shape)}`);
	if (!["start", "end"].includes(theme.rail?.side)) fail("rail.side", `expected start or end, got ${JSON.stringify(theme.rail?.side)}`);
	if (!LENGTH.test(theme.rail?.width)) fail("rail.width", `expected a length like 14rem, got ${JSON.stringify(theme.rail?.width)}`);
	if (!LENGTH.test(theme.measure)) fail("measure", `expected a length like 31em, got ${JSON.stringify(theme.measure)}`);
	for (const key of ["spectrum", "leader", "anchors"]) {
		if (typeof theme.signature?.[key] !== "boolean") fail(`signature.${key}`, `expected true or false, got ${JSON.stringify(theme.signature?.[key])}`);
	}

	// Unknown keys are typos otherwise silently ignored — a misspelled
	// `theme.raill` would just fall back to the default rail with no warning.
	for (const key of Object.keys(theme)) {
		if (!(key in THEME_DEFAULTS)) fail(key, `unknown key; valid keys are ${Object.keys(THEME_DEFAULTS).join(", ")}`);
	}
	for (const key of Object.keys(theme.fonts || {})) {
		if (!(key in THEME_DEFAULTS.fonts)) fail(`fonts.${key}`, `unknown key; valid keys are ${Object.keys(THEME_DEFAULTS.fonts).join(", ")}`);
	}
	for (const key of Object.keys(theme.rail || {})) {
		if (!(key in THEME_DEFAULTS.rail)) fail(`rail.${key}`, `unknown key; valid keys are ${Object.keys(THEME_DEFAULTS.rail).join(", ")}`);
	}
	for (const key of Object.keys(theme.signature || {})) {
		if (!(key in THEME_DEFAULTS.signature)) fail(`signature.${key}`, `unknown key; valid keys are ${Object.keys(THEME_DEFAULTS.signature).join(", ")}`);
	}

	return theme;
}

let cached;

export function loadSiteConfig() {
	if (cached) {
		return cached;
	}
	const base = JSON.parse(
		readFileSync(new URL("../_data/site.json", import.meta.url), "utf8"),
	);
	// SITE_FIXTURE may name several files, comma-separated, merged left to right.
	// That is what lets the demo scripts stack the sample identity with a theme
	// variant (see package.json's demo:serve:* scripts) without duplicating the
	// identity block into every variant fixture.
	let config = base;
	for (const fixture of (process.env.SITE_FIXTURE || "").split(",").map((f) => f.trim()).filter(Boolean)) {
		config = merge(config, JSON.parse(readFileSync(fixture, "utf8")));
	}

	// Colour inputs may also come from the environment, which is how an Indiekit
	// deployment sets them without editing a tracked file. Same precedence as
	// everything else here: the JSON file is the source, the environment
	// overlays it. Only these two are read — every other token is derived, so
	// there is nothing else to override.
	const envColors = {
		primary: process.env.INDIEKIT_COLOR_PRIMARY,
		secondary: process.env.INDIEKIT_COLOR_SECONDARY,
		surface: process.env.INDIEKIT_COLOR_SURFACE,
	};
	for (const [key, value] of Object.entries(envColors)) {
		if (value) {
			config = merge(config, { theme: { [key]: value } });
		}
	}

	config = merge(config, { theme: merge(THEME_DEFAULTS, config.theme || {}) });
	validateTheme(config.theme);

	// Only cache once validation has passed, so a throw here does not poison a
	// later call — with `cached` set before validating, a second
	// loadSiteConfig() after a failed build would return the invalid config
	// instead of re-validating and throwing again.
	cached = config;
	return cached;
}

export default loadSiteConfig;
