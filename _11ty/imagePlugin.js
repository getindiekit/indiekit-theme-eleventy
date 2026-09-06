import fs from "node:fs";
import path from "node:path";
import Image, { eleventyImageTransformPlugin } from "@11ty/eleventy-img";
import { getImageColors } from "@11ty/image-color";
import { loadSiteConfig } from "./siteConfig.js";

const siteData = loadSiteConfig();

const SIZES_INLINE = "(min-width: 75em) 44.5625em, (min-width: 61.25em) 40.6875em, (min-width: 41.25em) 36.8125em, 96vw";

// Matches the port source (zachleat.com/_11ty/imagePlugin.js:12): the same
// run-mode idiom used for webmentions and npm downloads.
//
// An earlier revision set a flat "*" here, on the reasoning that eleventy-img
// keys its cache on the source file's own content so nothing could go stale.
// That reasoning was wrong about which code path this option feeds.
// eleventy-img only builds cacheOptions — and only reads `duration` — inside
// `if (this.isRemoteUrl)` (eleventy-img/src/image.js:88-98). For a LOCAL file
// source the duration is never consulted at all, so "*" bought nothing there;
// for a REMOTE src it is the one case where the value matters, and "*" would
// pin stale remote bytes permanently with no way to refresh.
//
// imageFactory is generic and exported, so a future caller passing a remote
// URL must not silently inherit a permanent cache. Keyed, like the source.
// Exported (not just a local const) so test/build.mjs can assert the real
// value used, rather than scanning source text for a keyword.
export const IMAGE_CACHE_DURATION =
	process.env.ELEVENTY_RUN_MODE === "serve" ? "30d" : "1d";

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

// --- Task 20: og:image (mechanism 1 — this site's OWN social cards) ------
//
// Deliberately kept apart from getOpenGraphImageUrl() above. That function
// (v1.opengraph.11ty.dev) reads the og:image a THIRD-PARTY page already
// declares — see its call sites (opengraphImageHtmlWithClass, used for
// <browser-window> link previews of someone else's URL). It has never been
// wired to this site's own og:image tag and still isn't: doing so would ask
// that service to read the og:image of the page currently being generated.
//
// This block builds the value that DOES fill this site's own og:image:
// either a real photo, a screenshot-service URL of a card page this theme
// generates (content/opengraph-images.liquid), or a static default image.
// Confirmed from source (documentation-central/docs/2026-08-30-zachleat-
// opengraph-implementation.md §B.3, verified against zachleat.com/_11ty/
// imagePlugin.js:100-234 directly): the screenshot service is never called
// at build time either there or here — getScreenshotUrl()/
// getScreenshotUrlFromPath() only concatenate a string; nothing in this
// file or that one issues an HTTP request. The render happens later, in
// the screenshot service's own process, the first time something requests
// that URL. So there is no fetch to gate offline and no cache to manage
// here — site.json's opengraph.screenshotUrlTemplate is opt-in precisely
// because it's a third-party host, not because of any network cost at
// build time.
const LOCAL_HOST_RE = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;

function absoluteSiteUrl(pathOrUrl) {
	return new URL(pathOrUrl, siteData.url).toString();
}

// Single source of truth for "should og:image point at a generated card".
// False whenever no third-party screenshot service is configured (the
// theme's own default — see _data/site.json) or when site.url can't be
// reached by an external service, which is always true of the theme's own
// http://localhost:8080 default. A screenshot service given a localhost
// target can never render it, so refusing to emit that URL at all — falling
// back to the static default image instead — is the only honest behaviour.
function cardsEnabled() {
	const template = siteData.opengraph && siteData.opengraph.screenshotUrlTemplate;
	if (!template) {
		return false;
	}
	if (LOCAL_HOST_RE.test(siteData.url)) {
		console.warn(
			`[opengraph] screenshotUrlTemplate is set but site.url (${siteData.url}) is not publicly reachable by an external service; og:image will use the static default image instead.`,
		);
		return false;
	}
	return true;
}

// content/opengraph-images.liquid, the card page set this builds one-per-
// post. Ignored outside build mode — the same ELEVENTY_RUN_MODE idiom
// already used for image caching (IMAGE_CACHE_DURATION below) and for
// dropping drafts (eleventy.config.js), not a second custom env var —
// mirroring the port source's own PRODUCTION_BUILD-only gate (spec §A.5)
// without inventing a new flag this repo doesn't otherwise use. Building
// the page set is independent of cardsEnabled(): it costs one extra render
// per post regardless of whether a screenshot service is configured, but
// costs nothing extra to gate on run mode alone, and keeps "how many card
// pages get built" answerable without also depending on site.json.
export const OG_CARD_TEMPLATE = "./content/opengraph-images.liquid";

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
		// copy .cache to output folder. The cache only exists once an image has
		// been transformed; a site with no images yet (a fresh install, or the
		// sample posts switched off) has none, and cpSync on a missing source
		// throws ENOENT and fails the whole build.
		eleventyConfig.on("eleventy.after", () => {
			if (!fs.existsSync(TEMP_DIR)) return;
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

	// og:image for THIS site's own pages (mechanism 1 — see the block above
	// getOpenGraphImageUrl for why this is a separate mechanism). Called
	// from _includes/layouts/base.liquid as
	// `{% ogImageSource page.url, postType, photo %}` — postType/photo are
	// already in scope there via the ordinary Liquid data cascade, the same
	// way `title`/`noindex` already are.
	//
	// Never returns "" (contrast zachleat.com's own imagePlugin.js:219,
	// which does for a post under 60 days old with no git-committed
	// timestamp yet — see content/opengraph-images.liquid's front-matter
	// comment for why that freshness check isn't ported).
	eleventyConfig.addLiquidShortcode("ogImageSource", (pageUrl, postType, photo) => {
		// 1. A photo post's own image always wins — real content beats a
		// generated card, on every platform, whether or not cards are
		// enabled. Skips the card entirely, per plan Task 20 step 3.
		const photoUrl = Array.isArray(photo) && photo.length > 0 ? photo[0].url : undefined;
		if (postType === "photo" && photoUrl) {
			return absoluteSiteUrl(photoUrl);
		}

		// 2. A generated card, only for an actual post (postType set) and
		// only when a screenshot service is configured for a publicly
		// reachable site.url. `/opengraph${pageUrl}` matches the permalink
		// content/opengraph-images.liquid builds for this same post.
		if (postType && cardsEnabled()) {
			const target = absoluteSiteUrl(`/opengraph${pageUrl}`);
			return siteData.opengraph.screenshotUrlTemplate.replace("{url}", encodeURIComponent(target));
		}

		// 3. Static default — a real file committed in this theme
		// (static/img/og-default.png), never an empty string.
		const defaultImage = (siteData.opengraph && siteData.opengraph.defaultImage) || "/img/og-default.png";
		return absoluteSiteUrl(defaultImage);
	});

	eleventyConfig.addLiquidShortcode("ogImageAlt", (postType, photo, title) => {
		const photoAlt = Array.isArray(photo) && photo.length > 0 ? photo[0].alt : undefined;
		if (postType === "photo" && photoAlt) {
			return photoAlt;
		}
		if (title) {
			return `Social card for “${title}”`;
		}
		return `Social card for ${siteData.name}`;
	});

	// Plain-text extraction for a note/reply's own body (content/opengraph-
	// images.liquid) — strips markup rather than reusing the existing
	// `truncate` filter (webmentionsPlugin.js), which appends a literal
	// `<span class="tag-inline">Truncated</span>` HTML fragment. That's
	// correct for a webmention comment rendered as HTML; the OG card needs
	// plain text with no injected markup, so this is a separate, smaller
	// filter rather than a shared one with divergent output shapes.
	eleventyConfig.addLiquidFilter("ogPlain", (html) => {
		return String(html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
	});

	eleventyConfig.addLiquidFilter("ogTruncate", (text, max = 200) => {
		const s = String(text ?? "");
		if (s.length <= max) {
			return s;
		}
		return s.slice(0, max).replace(/\s+\S*$/, "") + "…";
	});

};

export {
	opengraphImageHtmlWithClass as opengraphImageHtml,
};

