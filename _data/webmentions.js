import { DateTime } from "luxon";
import Fetch from "@11ty/eleventy-fetch";

import siteData from "./site.json" with { type: "json" };
import getBaseUrl from "../_includes/getBaseUrl.js";
import getHostname from "../_includes/getHostname.js";

// Configuration Parameters
// site.json has no `domain` key (its keys are name/url/author/speedlify) —
// derive it from `url` instead of adding a second key that could drift out
// of sync with it.
const domain = getHostname(siteData.url);
const API_ORIGIN = 'https://webmention.io/api/mentions.jf2';
const TOKEN = process.env.WEBMENTION_IO_TOKEN;
const CACHE_DURATION = process.env.ELEVENTY_RUN_MODE === "serve" ? "30d" : "2h";

async function getWebmentionPage(pageNumber = 0) {
	// https://github.com/aaronpk/webmention.io#api
	// TODO move to use since_id instead of since date
	let url = `${API_ORIGIN}?domain=${domain}&token=${TOKEN}&per-page=9999&page=${pageNumber}`;
	// if (since) {
	// 	url += `&since=${since}`;
	// }

	return Fetch(url, {
		type: "json",
		duration: CACHE_DURATION,
	});
}

async function fetchWebmentions() {
	if (!domain || domain === 'myurl.com') {
		// If we dont have a domain name, abort
		console.warn(
			'[indiekit-theme-eleventy-reference] unable to fetch webmentions: no domain specified in metadata.'
		);
		return [];
	}
	if (!TOKEN) {
		// If we dont have a domain access token, abort
		console.warn(
			'[indiekit-theme-eleventy-reference] unable to fetch webmentions: no access token specified in environment.'
		);
		return [];
	}

	let results = [];
	let keepFetching = true;
	let page = 0;
	while(keepFetching) {
		let feed = await getWebmentionPage(page);
		let resultCount = feed?.children?.length || 0;
		results.push(...feed?.children || []);

		if(resultCount === 0 || resultCount < 9999) {
			keepFetching = false;
			break;
		}
		page++;
	}

	if(process.env.ELEVENTY_RUN_MODE === "build") {
		console.log( `[indiekit-theme-eleventy-reference] Found ${results.length} total webmentions.` );
	}

	return results;
}

export default async function({ eleventy }) {
	// A build with no token — CI, a fresh clone, an offline machine — must
	// still produce pages, and must never touch the network. Both offline
	// paths below skip fetchWebmentions() (and therefore the network fetch)
	// entirely, and feed the same raw webmention.io "children" shape into the
	// grouping/dedup/sort logic below, so every path returns the identical
	// { count, mentions } shape the webmentionsForUrl filter expects.
	let webmentionsResults;
	if (process.env.WEBMENTIONS_FIXTURE) {
		const { readFileSync } = await import("node:fs");
		let fixture = JSON.parse(readFileSync(process.env.WEBMENTIONS_FIXTURE, "utf8"));
		webmentionsResults = fixture.children || [];
	} else if (!TOKEN) {
		webmentionsResults = [];
	} else {
		webmentionsResults = await fetchWebmentions();
	}

	let mentions = {};
	for(let webmention of webmentionsResults) {
		let url = getBaseUrl(webmention["wm-target"]);
		if(!mentions[url]) {
			mentions[url] = [];
		}

		mentions[url].push(webmention);
	}

	let totalCount = 0;
	for(let url in mentions) {
		// De-dupe by wm-id (replaces lodash.uniqBy — lodash isn’t a dependency
		// of this theme). Map preserves first-seen key order like uniqBy, but
		// unlike uniqBy it keeps the LAST value seen for a repeated key, not
		// the first. Kept deliberately: a later duplicate in the feed is a
		// more current copy of that webmention, so preferring it over the
		// first-seen one is the more correct behaviour here.
		mentions[url] = [...new Map(mentions[url].map(entry => [entry["wm-id"], entry])).values()];

		totalCount += mentions[url].length;
		mentions[url].sort((a, b) => {
			return DateTime.fromISO(b.published || b["wm-received"], { zone: "utc" }).toJSDate().getTime() - DateTime.fromISO(a.published || a["wm-received"], { zone: "utc" }).toJSDate().getTime();
		});
	}

	// IF YOU’RE WANTING TO FILTER A HOST OUT OF BEING LISTED IN WEBMENTIONS
	// DO THIS IN eleventy.config.js -> webmentionsForUrl filter
	return {
		count: totalCount,
		mentions,
	};
}
