# SpotyMusic — open-source, no-subscription music player

A responsive, local-first **MIT-licensed** music player that searches multiple free-to-access music catalogs, streams provider-authorized recordings, and plays internet radio and your own music files. No account, checkout, payment gateway or premium tier in SpotyMusic.

**Not a Spotify catalog unlock.** Third-party catalogs do not guarantee every new Bollywood, Punjabi, Hindi or international commercial song. Each track/station remains subject to its original provider's copyright, licensing, terms, browser format support and availability.

## Music providers (four integrated)

| Provider | What is available | Mode | API / license information |
| --- | --- | --- | --- |
| [Audius](https://docs.audius.co/api/) | Artist-uploaded tracks, newest and trending releases | On-demand, source-authorized stream | Public read API; not all uploads are freely streamable |
| [Openverse](https://api.openverse.org/v1/) | Indexed Creative Commons and public-domain music/audio | Direct stream if original audio URL works | Anonymous rate-limited REST search; each result carries original attribution/license |
| [Wikimedia Commons](https://www.mediawiki.org/wiki/API:Cross-site_requests) | Freely licensed/public-domain audio files | Direct streaming from Commons | MediaWiki CORS API; per-file license and credits on its file page |
| [Radio Browser](https://api.radio-browser.info/) | Public internet radio station listings worldwide | **Live radio**, not seekable on-demand songs | Free/open-source station-directory API; each station's stream and rights remain separate |

Each result shows the provider and source/credit link. **The app's MIT license covers app code, not externally hosted music.** Attribution and redistribution rules vary, and not all providers offer permission to download or reuse tracks. Listening to public radio doesn't give permission to record or redistribute broadcasts.

## Run locally (₹0 software charge)

Clone the repository:

\`\`\`bash
git clone https://github.com/humaniods/spotymusic.git
cd spotymusic
python3 -m http.server 5173
# Open http://localhost:5173
\`\`\`

No packages or API credentials are needed to run the static player. To run tests: \`npm test\` (Node 18+; CI uses Node 22).

Click **Free Music** → select **All 4 sources** or a particular provider → choose **New releases**, **Popular & radio**, or search for a song/artist/station. Click any streamable result to play, like, or add it to a playlist. Radio is live: seeking/duration are disabled. Import your own audio on the Home/Library screens.

### Important behavior

- Audius has a real latest-upload catalog. Openverse's "new" sorting means **recently indexed**, not necessarily released today. Commons and radio discovery are searches/top-ranked stations and not a chronological release calendar.
- On free-source search, each API runs separately; if one source is down or rate-limited, the others still display. Errors appear under the search filters.
- Some returned audio URLs may fail due to unsupported codecs, provider hotlinking policies, browser CORS, region rules or removed files. The player shows an error instead of promising universal playback.
- No paid subscriptions or keys are embedded. Spotify URLs still use Spotify's official embeddable player and its own rules.
- Existing local MP3/WAV/etc. imports and Spotify embeds continue to work, as do playlists and likes.

### Privacy and persistence

Imported local songs stay in browser IndexedDB; saved favorites, playlists and link/stream metadata stay in browser localStorage. Online streams play from the upstream providers (who receive ordinary requests). No self-hosted tracking, payment information collection or account database.

### Development

- \`src/audius.mjs\` — Audius search and stream URLs
- \`src/providers.mjs\` — Openverse, Wikimedia Commons, Radio Browser adapters + multi-source aggregator
- \`src/free-catalog.mjs\` — source selector, search, listings and pagination
- \`src/app.mjs\` — player, queues, local files, favorites and playlists
- \`tests/*.test.mjs\` — deterministic test fixtures and error handling
- \`.github/workflows/tests.yml\` — GitHub Actions syntax checks + unit tests

This application is independent of Spotify, Openverse, Audius, Wikimedia and Radio Browser and is not endorsed by those services. No scraping, DRM bypass, copyrighted catalog rehosting or premium-feature circumvention is part of this project.

## License

[MIT](./LICENSE) for original application source code. Media accessed through the app carries its own copyright and license terms.
