// Bare hostname from a URL, e.g. "https://example.com/path" -> "example.com".
// Shared source of truth for:
//  - _data/webmentions.js, deriving the webmention.io API `domain` param from
//    site.json's `url` (site.json has no separate `domain` key — see its
//    comment for why one isn't added)
//  - the `hostnameFromUrl` Liquid filter in _11ty/webmentionsPlugin.js, used
//    both on our own site.json url (webmentionlist.liquid's webmention.io
//    form action) and on remote, untrusted webmention data
// Returning "" on a malformed URL (rather than throwing) matters most for the
// remote-data case: a malformed `webmention.url` must not crash the build.
export default function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
