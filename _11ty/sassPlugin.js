import * as sass from 'sass'
import path from "node:path";

// Memoised result of the one-off critical-CSS compile below (module scope,
// so it survives across the many calls the "inlineCriticalCss" shortcode
// gets per build, but not across separate build processes).
let criticalCssResult;

export default function(eleventyConfig, pluginOptions = {}) {
	// The two configured colours reach Sass through a VIRTUAL module rather than
	// a generated file on disk. `@use` rules must come first in a stylesheet, so
	// the values cannot simply be prepended to the source, and writing a
	// _theme-config.scss into content/ would put a build artifact in the input
	// tree. An importer keeps it in memory and applies to every compile below.
	const theme = pluginOptions.theme || {};
	const themeConfigSource = [
		`$primary: ${theme.primary || "#9435f4"};`,
		`$secondary: ${theme.secondary || "#f0a000"};`,
		`$surface: ${theme.surface || "#ffffff"};`,
	].join("\n");

	const themeConfigImporter = {
		canonicalize(url) {
			return url === "theme-config" ? new URL("virtual:theme-config") : null;
		},
		load(canonicalUrl) {
			return canonicalUrl.href === "virtual:theme-config"
				? { contents: themeConfigSource, syntax: "scss" }
				: null;
		},
	};

	eleventyConfig.addTemplateFormats("scss");

	eleventyConfig.addExtension("scss", {
		compileOptions: {
			cache: false,
		},
		outputFileExtension: "css",
		compile: function (inputContent, inputPath) {
			let parsed = path.parse(inputPath);

			// skip underscore file names
			if(parsed.name.startsWith("_")) {
				return;
			}

			let result = sass.compileString(inputContent, {
				loadPaths: [
					parsed.dir || ".",
					this.config.dir.includes
				],
				importers: [themeConfigImporter],
			});

			this.addDependencies(inputPath, result.loadedUrls);

			return (data) => {
				return result.css;
			};
		}
	});

	// Inlines the compiled critical-CSS bundle into a <style> tag for
	// production builds (base.liquid). Mirrors the port source's
	// `{% renderFile "./static/initial.scss" %}` (zachleat.com,
	// _includes/layouts/base.liquid:52) — this theme has no `renderFile`
	// shortcode registered, so this reuses the `sass` dependency this
	// plugin already imports for the one call site that needs it, rather
	// than adding a generic file-render shortcode.
	//
	// The output of this compile is invariant for a given build (same input
	// file, same content) but the shortcode fires once per page render — 8
	// identical ~10 KB compiles for an 8-page build. Memoise at module level
	// so it compiles once per process. Only a *successful* result is cached:
	// `criticalCssResult` is assigned solely on the line below, inside the
	// `if`, so a thrown Sass error propagates uncaught (same as before —
	// build still fails loudly) and is never memoised as a false success or
	// swallowed into an empty bundle; the next call would simply retry.
	eleventyConfig.addLiquidShortcode("inlineCriticalCss", function () {
		if (!criticalCssResult) {
			criticalCssResult = sass.compile("content/_css/initial.scss", {
				loadPaths: ["content/_css", "_includes"],
				importers: [themeConfigImporter],
			});
		}
		return criticalCssResult.css;
	});
};
