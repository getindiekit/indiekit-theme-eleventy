import sanitizeHTML from "sanitize-html";
import { DateTime } from "luxon";

import webmentionBlockList from "../_data/webmentionsBlockList.json" with { type: "json" };
import siteData from "../_data/site.json" with { type: "json" };
import getBaseUrl from "../_includes/getBaseUrl.js";

export default function(eleventyConfig) {

	const allowedHTML = {
		allowedTags: ['b', 'i', 'em', 'strong', 'a'],
		allowedAttributes: {
			a: ['href']
		}
	};

	eleventyConfig.addLiquidFilter('sanitizeHTML', content => {
		return content ? sanitizeHTML(content, allowedHTML) : "";
	});

	// The source registers htmlEntities/hostnameFromUrl/readableDateFromISO in
	// its main eleventy.config.js (using the `html-entities` and `memoize` npm
	// packages), not alongside the webmention templates. Neither package is a
	// dependency of this theme, so these are native equivalents scoped to the
	// webmention templates that need them — not stubs, real implementations.
	eleventyConfig.addLiquidFilter('htmlEntities', str => {
		return String(str).replace(/[&<>"']/g, char => ({
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		}[char]));
	});

	eleventyConfig.addLiquidFilter('hostnameFromUrl', url => {
		return new URL(url).hostname;
	});

	eleventyConfig.addLiquidFilter('readableDateFromISO', (dateStr, formatStr = "dd LLL yyyy 'at' hh:mma") => {
		return DateTime.fromISO(dateStr).toFormat(formatStr);
	});

	// Source hardcodes its own domain here; use this theme's own site.json url
	// instead, since the theme is shared and must stay neutral.
	eleventyConfig.addLiquidFilter('localUrl', absoluteUrl => {
		return absoluteUrl.replace(siteData.url, "");
	});

	eleventyConfig.addFilter('webmentionIsType', (webmention, type) => {
		return type === webmention['wm-property'];
	});

	eleventyConfig.addFilter('webmentionsForUrl', (webmentions, url, allowedTypes) => {
		if( !allowedTypes ) {
			// all types
			allowedTypes = ['mention-of', 'in-reply-to', 'like-of', 'repost-of', 'bookmark-of'];
		} else {
			allowedTypes = allowedTypes.split(",");
		}

		if(!url || !webmentions.mentions || !webmentions.mentions[url]) {
			return [];
		}

		let knownUrls = {};
		return webmentions.mentions[url]
			.filter(entry => {
				if(!allowedTypes.includes(entry['wm-property'])) {
					return false;
				}

				if(webmentionBlockList.filter(blockedUrl => {
					return `${entry.url}`.startsWith(blockedUrl) || entry.url.indexOf(blockedUrl) > -1
				}).length > 0) {
					return false;
				}
				if(getBaseUrl(entry['wm-target']) !== url) {
					return false;
				}
				// no dupes
				if(entry.url) {
					if(knownUrls[entry.url]) {
						return false;
					}
					knownUrls[entry.url] = true;
				}
				return true;
			}).sort((a, b) => {
				// Show oldest entries first
				let adate = a.published || a['wm-received'];
				let bdate = b.published || a['wm-received'];
				if(bdate < adate) {
					return 1;
				} else if(bdate > adate) {
					return -1;
				}
				return 0;
			});
	});
};
