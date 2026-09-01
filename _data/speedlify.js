// Build-time index of the URLs a Speedlify instance actually measures.
//
// WHY THIS EXISTS. The <speedlify2-score> badge in _includes/footer.html
// fetches its score client-side from the configured instance. If that instance
// has no entry for the current page, the badge renders as an empty box. The
// port source solves this by gating the badge on a build-time lookup
// (_data/speedlify.js + `{% if speedlify[urlWithOrigin] %}` in its footer), and
// it needs to: www.speedlify.dev tracks 40 URLs, of which only 11 are its own
// pages — the badge is deliberately absent from the other ~500.
//
// WHAT A SPEEDLIFY INSTANCE IS. Not a public submission service. It is a
// self-hosted Eleventy project that crawls a URL list its owner configures, and
// exposes that list at <instance>/api/urls.json. www.speedlify.dev is the
// canonical public one, but it only measures its owner's curated set (SSG
// marketing sites + zachleat.com pages), so pointing an arbitrary domain at it
// yields no entry and — thanks to the gate below — no badge. To get scores for
// your own domain you run your own instance and set speedlify.url to it.
//
// OFFLINE CONTRACT. Same as _data/npmDownloads.js and _data/webmentions.js: a
// fresh clone and CI must build with no network. Three layers:
//   1. speedlify.enabled is false by default, and a disabled site NEVER fetches
//      — so the default build has no network dependency at all.
//   2. SPEEDLIFY_FIXTURE=<path> reads a local urls.json instead of fetching
//      (mirrors WEBMENTIONS_FIXTURE), which is how test/build.mjs exercises
//      the gate deterministically.
//   3. SPEEDLIFY_OFFLINE=1 skips the fetch outright.
// Any unexpected failure degrades to {} — no entries, so no badge — rather
// than breaking the build, except under NODE_ENV=production where a deployer
// has asked for loud failures.
import { readFileSync } from "node:fs";
import EleventyFetch from "@11ty/eleventy-fetch";
import siteData from "./site.json" with { type: "json" };

// See _data/webmentions.js for how process.env.ELEVENTY_RUN_MODE is verified
// to actually carry Eleventy's real run mode here (not a guessed env var).
const CACHE_DURATION = process.env.ELEVENTY_RUN_MODE === "serve" ? "30d" : "1d";

// Named (not anonymous) solely so CACHE_DURATION can be attached below as a
// property of the exported function — see _data/npmDownloads.js for why this
// must NOT be a second `export const` (Eleventy's data-file loader only
// auto-invokes a module whose sole export is `default`).
export default async function getSpeedlifyUrls() {
	const config = siteData.speedlify || {};

	// Disabled is the neutral default: no config, no fetch, no network.
	if (!config.enabled || !config.url) {
		return {};
	}

	if (process.env.SPEEDLIFY_FIXTURE) {
		return JSON.parse(readFileSync(process.env.SPEEDLIFY_FIXTURE, "utf8"));
	}

	if (process.env.SPEEDLIFY_OFFLINE) {
		return {};
	}

	// site.json's url convention has no trailing slash; the API path needs one.
	const base = config.url.endsWith("/") ? config.url : `${config.url}/`;

	try {
		return await EleventyFetch(`${base}api/urls.json`, {
			type: "json",
			duration: CACHE_DURATION,
			directory: ".cache/eleventy-fetch/",
			dryRun: false,
		});
	} catch (error) {
		if (process.env.NODE_ENV === "production") {
			// Fail the build in production. A deployer who sets NODE_ENV=production
			// without SPEEDLIFY_OFFLINE gets a hard failure on any transient
			// outage — set SPEEDLIFY_OFFLINE=1 to skip the fetch entirely instead.
			return Promise.reject(error);
		}

		console.log(
			`[indiekit-theme-eleventy-reference] Speedlify index unreachable at ${base}api/urls.json — badge suppressed.`,
		);
		return {};
	}
}

// test/build.mjs reads this off the default export to assert the real computed
// value against real builds in both run modes, not just scan for the string.
getSpeedlifyUrls.CACHE_DURATION = CACHE_DURATION;
