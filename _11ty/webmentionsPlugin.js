import sanitizeHTML from "sanitize-html";
import { DateTime } from "luxon";

import webmentionBlockList from "../_data/webmentionsBlockList.json" with { type: "json" };
import siteData from "../_data/site.json" with { type: "json" };
import getBaseUrl from "../_includes/getBaseUrl.js";
import getHostname from "../_includes/getHostname.js";

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

	// Used both on our own site.json url (webmentionlist.liquid's webmention.io
	// form action) and on remote, untrusted `webmention.url`/`wm-target`
	// values — a malformed remote URL must not crash the build, so this
	// deliberately returns "" instead of the source's throwing `new
	// URL(url).hostname`.
	eleventyConfig.addLiquidFilter('hostnameFromUrl', url => {
		return getHostname(url);
	});

	eleventyConfig.addLiquidFilter('readableDateFromISO', (dateStr, formatStr = "dd LLL yyyy 'at' hh:mma") => {
		return DateTime.fromISO(dateStr).toFormat(formatStr);
	});

	// Source registers this in its main eleventy.config.js, not here — ported
	// alongside the other webmention-only filters since nothing else uses it.
	// Without registering it at all, `| truncate` in webmention.liquid silently
	// resolves to LiquidJS's own built-in `truncate` (default length 50), which
	// clips comment bodies mid-word with no visual indicator.
	// `showBadge` opts out of the "Truncated" pill. The badge is a WEBMENTION
	// affordance — it tells a reader a visitor's comment was clipped, in a
	// context where the full text lives elsewhere. A post listing reuses this
	// filter to build its excerpts, and there the badge reads as noise: every
	// note longer than 70 characters grew a "Truncated" label mid-row, and
	// (before p-name was corrected) that label was literally inside the post's
	// machine-readable name. Listings pass false; comments keep the default.
	eleventyConfig.addLiquidFilter('truncate', (str, len = 280, showBadge = true) => { // tweet sized default
		if (str.length <= len) {
			return str;
		}
		const suffix = showBadge ? `… <span class="tag-inline">Truncated</span>` : "…";
		return str.substr(0, len) + suffix;
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
				// Deliberate divergence from source: source reads `a['wm-received']`
				// here too (a faithfully-ported bug), which effectively ignores `b`'s
				// wm-received value in the fallback. Fixed to read `b`'s own field —
				// do not "restore" this to match source.
				let adate = a.published || a['wm-received'];
				let bdate = b.published || b['wm-received'];
				if(bdate < adate) {
					return 1;
				} else if(bdate > adate) {
					return -1;
				}
				return 0;
			});
	});
};
