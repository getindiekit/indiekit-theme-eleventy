# Credits

This theme is not original work. It is a port, and the great majority of what
makes it look and behave the way it does was written by other people. This file
records who, and what they are owed.

## Zach Leatherman — the theme this was ported from

**[zachleat.com](https://zachleat.com/)** is the source of this theme's design
and the large majority of its implementation: the layout system, the Sass, the
`.posts` dotted link-list, the typographic scale and fluid title clamps, the
webmention templates and facepiles, the search UI, the Open Graph card
mechanism, the image and avatar plugins, the critical/deferred CSS split, and
the accessibility floor. Where this port diverges it says so in a comment,
usually citing the source file and line it is departing from.

That codebase is MIT licensed, and its notice is reproduced in full at the
bottom of this file, as the licence requires.

Zach also wrote **Eleventy**, which this theme is built on, and **18 of the 24
npm dependencies** it installs (see the table below). Attribution here is not a
formality: without that body of work this theme would not exist in any form.

## Paul Robert Lloyd — Indiekit

**[Indiekit](https://getindiekit.com/)** is the Micropub/IndieAuth server this
theme exists to serve. Its six post types (`article`, `note`, `bookmark`,
`like`, `reply`, `photo`), its store layout, its JF2 front matter and its
`post-status: draft` convention are what the templates are shaped around. Four
of those six types are titleless by design, and that single fact drove most of
this port's genuine divergences from the source.

## The IndieWeb community

- **[microformats2](https://microformats.org/wiki/microformats2)** — the `h-entry`
  / `h-feed` / `u-url` / `p-author` vocabulary this theme emits.
- **[Webmention](https://www.w3.org/TR/webmention/)** (W3C Recommendation) and
  **[webmention.io](https://webmention.io/)** by **Aaron Parecki**, which this
  theme reads replies, likes and reposts from.
- **[Bridgy](https://brid.gy/)** by **Ryan Barrett**, which is why syndicated
  conversation can come home at all, and why `u-syndication` matters.

## Dependencies

Every dependency is MIT licensed.

| Package | Author |
|---|---|
| `@11ty/eleventy`, `-fetch`, `-img`, `-plugin-rss`, `-plugin-syntaxhighlight`, `-plugin-webc`, `font-awesome`, `image-color`, `is-land` | Zach Leatherman |
| `@zachleat/browser-window`, `carouscroll`, `details-utils`, `filter-container`, `flex-luthor`, `heading-anchors`, `line-numbers`, `pagefind-search`, `table-saw` | Zach Leatherman |
| `pagefind` | Pagefind (CloudCannon) |
| `sass` | Natalie Weizenbaum |
| `luxon` | Isaac Cambron |
| `markdown-it` | markdown-it contributors |
| `markdown-it-table-of-contents` | Chris Maas |
| `sanitize-html` | Apostrophe Technologies |

Icons are **Font Awesome**, via `@11ty/font-awesome`. Avatars in webmention
facepiles are resolved at view time by `v1.indieweb-avatar.11ty.dev`.

## What this port adds

Not a claim of ownership — the licence above governs the whole of it. Simply a
record of which parts were written for Indiekit rather than carried over, so
the next person can tell them apart: the microformats2 templates for Indiekit's
six post types and their data cascade; the titleless-post handling (synthetic
feed titles, conditional `p-name`, per-type listing excerpts); the date
resolution across YAML forms, explicit offsets and timezones; the neutral
configuration surface in `_data/site.json`; the `p-author` / `u-syndication` /
`p-category` layer the source has no equivalent of; and the test suite.

---

## MIT License notice — zachleat.com

The MIT License (MIT)

Copyright © 2018 Zach Leatherman

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
