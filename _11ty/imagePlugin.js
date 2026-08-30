import fs from "node:fs";
import path from "node:path";
import Image, { eleventyImageTransformPlugin } from "@11ty/eleventy-img";
import { getImageColors } from "@11ty/image-color";

const SIZES_INLINE = "(min-width: 75em) 44.5625em, (min-width: 61.25em) 40.6875em, (min-width: 41.25em) 36.8125em, 96vw";

// Deviation from the port source: zachleat.com/_11ty/imagePlugin.js:12 keys
// this the same run-mode idiom as webmentions/npm downloads (1d build / 30d
// serve). Task 15 brief calls for a flat "*" here instead, and that's the
// right call for this input: webmentions/npm downloads are time-varying data
// fetched from a remote API that can change independently of the cache key,
// so a stale cache genuinely goes stale. `imageFactory`'s Image() calls are
// keyed by eleventy-img on the source file's own content/stat — a changed
// source image gets a different cache key regardless of duration, so there
// is nothing external to go stale against. A permanent cache is therefore
// both safe and simpler. Exported (not just a local const) so test/build.mjs
// can assert the real value used, not scan source text for a keyword.
export const IMAGE_CACHE_DURATION = "*";

async function imageFactory(src, options = {}) {
	options = Object.assign({},{
		widths: ["auto"],
		formats: ["avif", "jpeg"],
		failOnError: false,
		transformOnRequest: process.env.ELEVENTY_RUN_MODE === "serve",
		urlPath: "/img/built/",
		outputDir: "./_site/img/built/",
		sharpAvifOptions: {},
		cacheOptions: {
			duration: IMAGE_CACHE_DURATION,
		},
	}, options);

	// @11ty/eleventy-img
	return {
		options,
		metadata: await Image(src, options),
	}
}

export function getOpenGraphImageUrl(url, format = "") {
	let u = new URL(url);

	return `https://v1.opengraph.11ty.dev/${encodeURIComponent(u.toString())}/${format ? `auto/${format}/` : ""}`;
}

async function opengraphImageHtmlWithClass(targetUrl, alt = "", cls = "") {
	let fullUrl = getOpenGraphImageUrl(targetUrl);

	let options = {
		// careful, AVIF here is a little slow!
		formats: ["webp", "jpeg"],
		widths: [375, 650], // 1200 is not used, max rendered size is about 450px.
		statsOnly: true,
		urlFormat: function({width, format}) {
			let size;
			if(width <= 400) {
				size = "small";
			} else if(width <= 700) {
				size = "medium";
			} else {
				size = "auto";
			}

			return `${fullUrl}${size}/${format}/`;
		}
	};

	let stats = await Image(fullUrl, {
		...options,
		imageMetadataOverride: { width: 1200, height: 630 }
	});

	return Image.generateHTML(stats, {
		alt: alt ?? `OpenGraph image for ${targetUrl}`,
		loading: "lazy",
		decoding: "async",
		sizes: "(min-width: 64em) 50vw, 100vw",
		class: cls || "",
		"eleventy:ignore": "",
	});
}

export async function getFilteredImageColors(target) {
	if(process.env.ELEVENTY_RUN_MODE !== "build") {
		return [];
	}

	try {
		let colors = await getImageColors(target);
		return colors.filter(c => {
			// colors with good contrast with light text or extra good with dark text (white is boring)
			return (c.contrast.light >= 4.5 || c.contrast.dark > 7) && c.colorjs.oklch.l < .95;
		}).sort((a, b) => {
			// lightest + chroma colors first
			return (b.colorjs.oklch.l + b.colorjs.oklch.c) - (a.colorjs.oklch.l + a.colorjs.oklch.c);
		});
	} catch(e) {
		console.warn(`Error fetching colors for ${target}`, e.message);
		return [];
	}
}

export default function(eleventyConfig) {
	let TEMP_DIR = ".cache/@11ty/img/";
	let IMAGE_OUTPUT_DIR = path.join(eleventyConfig.directories.output, "img/built/");

	eleventyConfig.addPlugin(eleventyImageTransformPlugin, {
		urlPath: "/img/built/",
		// go through .cache on build
		outputDir: process.env.ELEVENTY_RUN_MODE === "build" ? TEMP_DIR : IMAGE_OUTPUT_DIR,
		failOnError: false,
		formats: ["svg", "avif", "jpeg"],
		svgShortCircuit: true,
		htmlOptions: {
			imgAttributes: {
				loading: "lazy",
				decoding: "async",
				sizes: SIZES_INLINE
			},
			pictureAttributes: {},
		}
	});

	if(process.env.ELEVENTY_RUN_MODE === "build") {
		// copy .cache to output folder
		eleventyConfig.on("eleventy.after", () => {
			fs.cpSync(TEMP_DIR, IMAGE_OUTPUT_DIR, { recursive: true });
		});
	}


	// Only one image format, and return only the URL
	eleventyConfig.addAsyncShortcode("getUrlForImage", async (src, width = "auto", format = "auto") => {
		let options = {
			eleventyConfig,
			formats: [ format ],
			widths: [ width ],
		};
		let { metadata } = await imageFactory(src, options);
		let outputFormat = Object.keys(metadata).pop();
		return metadata[outputFormat][0].url;
	});

	/* Hosted image service to optimize webmention photos */
	eleventyConfig.addLiquidFilter("eleventyImageServiceAvatar", (url) => {
		return `https://v1.image.11ty.dev/${encodeURIComponent(url)}/jpeg/72/`;
	});

};

export {
	opengraphImageHtmlWithClass as opengraphImageHtml,
};

