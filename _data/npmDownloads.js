// https://blog.npmjs.org/post/78719826768/download-counts-are-back
import EleventyFetch from "@11ty/eleventy-fetch";

const NPM_PKG_NAME = "@indiekit/indiekit";
const START_YEAR = 2020;
const CACHE_DURATION = process.env.ELEVENTY_RUN_MODE === "serve" ? "30d" : "1d";

async function getDownloadsForYear(year) {
	let isCurrentYear = (new Date).getFullYear() === year;
	let url = `https://api.npmjs.org/downloads/point/${year}-01-01:${year}-12-31/${NPM_PKG_NAME}`;
	let json = await EleventyFetch(url, {
		type: "json",
		duration: isCurrentYear ? CACHE_DURATION : "*",
		directory: ".cache/eleventy-fetch/",
		dryRun: false,
	});
	return json.downloads;
}

export default async function() {
	// CI and fresh clones must not need the network — same offline contract
	// as _data/webmentions.js. NPM_DOWNLOADS_OFFLINE is hardcoded by Task 11's
	// CI workflow; this is the exact name it sets.
	if (process.env.NPM_DOWNLOADS_OFFLINE) {
		return { downloads: 0 };
	}

	try {
		let count = 0;
		for(let year = START_YEAR, k = (new Date).getFullYear(); year<=k; year++) {
			count += await getDownloadsForYear(year);
		}
		if(process.env.ELEVENTY_RUN_MODE === "build") {
			console.log( `[indiekit-theme-eleventy-reference] Found ${count} npm downloads for ${NPM_PKG_NAME}.` );
		}
		return {
			downloads: count
		};
	} catch(e) {
		if(process.env.NODE_ENV === "production") {
			// Fail the build in production. Note: a deployer who sets
			// NODE_ENV=production without also setting NPM_DOWNLOADS_OFFLINE
			// gets a hard build failure on any transient npm API outage —
			// set NPM_DOWNLOADS_OFFLINE=1 to skip the fetch entirely instead.
			return Promise.reject(e);
		}

		console.log( "Failed getting npm downloads count, returning 0" );
		return {
			downloads: 0
		};
	}
};
