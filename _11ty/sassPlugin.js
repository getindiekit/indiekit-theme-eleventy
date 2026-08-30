import * as sass from 'sass'
import path from "node:path";

export default function(eleventyConfig) {
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
				]
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
	eleventyConfig.addLiquidShortcode("inlineCriticalCss", function () {
		let result = sass.compile("content/_css/initial.scss", {
			loadPaths: ["content/_css", "_includes"],
		});
		return result.css;
	});
};
