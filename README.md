# OpenMic — open-source, no-subscription music player

A responsive, local-first **MIT-licensed** music player that searches multiple free-to-access music catalogs, streams provider-authorized recordings, plays internet radio and your own music files, and lets independent artists open an account, publish their own recordings and have them streamed from your own server. No account, checkout, payment gateway or premium tier for listeners in OpenMic.

**Not a Spotify catalog unlock.** Third-party catalogs do not guarantee every new Bollywood, Punjabi, Hindi or international commercial song. Each track/station remains subject to its original provider's copyright, licensing, terms, browser format support and availability. Artist uploads are hosted by this app's own server — see **Artist uploads** below.

## Music sources (four open catalogs + artist uploads)

| Provider | What is available | Mode | API / license information |
| --- | --- | --- | --- |
| [Audius](https://docs.audius.co/api/) | Artist-uploaded tracks, newest and trending releases | On-demand, source-authorized stream | Public read API; not all uploads are freely streamable |
| [Openverse](https://api.openverse.org/v1/) | Indexed Creative Commons and public-domain music/audio | Direct stream if original audio URL works | Anonymous rate-limited REST search; each result carries original attribution/license |
| [Wikimedia Commons](https://www.mediawiki.org/wiki/API:Cross-site_requests) | Freely licensed/public-domain audio files | Direct streaming from Commons | MediaWiki CORS API; per-file license and credits on its file page |
| [Radio Browser](https://api.radio-browser.info/) | Public internet radio station listings worldwide | **Live radio**, not seekable on-demand songs | Free/open-source station-directory API; each station's stream and rights remain separate |
| **OpenMic artist uploads** | Recordings independent artists publish through **For artists** | On-demand, streamed from your own server at `/api/stream/<id>` | Upload is gated by a per-file rights warranty; each row links to the uploading artist's page |

Each result shows the provider and source/credit link. **The app's MIT license covers app code, not externally hosted music.** Attribution and redistribution rules vary, and not all providers offer permission to download or reuse tracks. Listening to public radio doesn't give permission to record or redistribute broadcasts.

## Run locally (₹0 software charge)

Clone the repository, then start the OpenMic server:

```bash
git clone https://github.com/humaniods/openmic.git
cd openmic
npm start          # node server/server.mjs → http://localhost:5173
```

`npm start` runs the dependency-free Node server (no `npm install` needed; Node 20+). It serves the app with correct cache headers, streams artist uploads, and answers `/api/*`. Artist uploads and account records are written to `./data/`, which is git-ignored.

The static player also runs on any plain file server (`npm run static`), in which case Free Music, local files and Spotify embeds keep working and the artist screens show "No OpenMic server is answering".

To run tests: `npm test` (58 tests, no network access — the server tests boot a real instance on an ephemeral port with a temporary data directory).

Click **Free Music** → select **All 4 sources** or a particular provider → choose **New releases**, **Popular & radio**, or search for a song/artist/station. Click any streamable result to play, like, or add it to a playlist. Radio is live: seeking/duration are disabled. Import your own audio on the Home/Library screens.

### Important behavior

- Audius has a real latest-upload catalog. Openverse's "new" sorting means **recently indexed**, not necessarily released today. Commons and radio discovery are searches/top-ranked stations and not a chronological release calendar.
- On free-source search, each API runs separately; if one source is down or rate-limited, the others still display. Errors appear under the search filters.
- Some returned audio URLs may fail due to unsupported codecs, provider hotlinking policies, browser CORS, region rules or removed files. The player shows an error instead of promising universal playback.
- No paid subscriptions or keys are embedded. Spotify URLs still use Spotify's official embeddable player and its own rules.
- Existing local MP3/WAV/etc. imports and Spotify embeds continue to work, as do playlists and likes.

### Artist uploads (For artists)

Listeners still need no account. An artist who wants to publish presses **For artists**, creates an email + password account and a public handle, then uploads audio files they have the rights to. Those recordings are hosted by this server and appear in **Community** for everyone.

- **Passwords** are salted `scrypt` hashes (N=16384) — never stored or logged in clear text. **Sessions** are random tokens sent as an `HttpOnly`, `SameSite=Lax` cookie; only their SHA-256 digest is stored, so a data-file leak cannot revive a login.
- **Uploads** are two calls: metadata first, then the raw bytes (`PUT /api/tracks/<id>/audio`). Nothing is published until the audio lands, and a pending upload cannot be streamed.
- **Content is checked, not trusted**: extension plus magic bytes must agree, MIME is allowlisted, per-file/per-user byte quotas and a per-user track count are enforced, and duplicate metadata+audio replays are rejected.
- **A rights warranty is required per upload** (`openmic-rights-1`): the artist states they own or licence the recording and that it contains no ripped, sampled or re-uploaded material they are not cleared to distribute. The text is served by `/api/meta`, so changing it invalidates previously accepted wording.
- **Playback** uses HTTP `Range` requests, so seeking works on long files and only the needed bytes cross the wire. The stream URL is built in the browser from the track id — a response body can never point the player at another host.
- **Public artist pages** (`/api/artists/<handle>`) expose name, handle, bio and published tracks. Email and password data are never returned.

### Artist assistant (AI support)

The **Studio** assistant drafts release titles from filenames, proposes genre/mood tags, drafts a short artist bio and — most importantly — flags rights problems before publishing (samples, covers, "type beat" stock, label deals, audio taken from a streaming link). Listeners get a smaller "describe a mood" search helper on the **Community** screen.

Two modes, same interface:

- **Local rules (default).** `server/ai.mjs` answers every task with no key, no network and no per-call cost. This is what runs in tests and on a fresh clone.
- **Optional model proxy.** Set `OPENMIC_AI_KEY`, `OPENMIC_AI_MODEL` and `OPENMIC_AI_BASE_URL`; the server forwards a fenced, task-scoped prompt and parses JSON back out. The key never reaches the browser, the model only ever sees the artist's own draft text plus the warranty wording, and if the upstream is slow or fails the local rules answer instead (`degraded: true` is shown).

### Rights, takedown and repeat infringers

An app that hosts user audio needs the safe-harbour mechanics, and OpenMic ships them:

- Anyone can file a notice from a track's flag button or the **Community** disclaimer (`POST /api/takedown`, anonymous allowed). A sloppy notice is rejected; a valid one must state the work, the URL, contact details and a good-faith statement.
- The recording is deleted immediately (metadata and audio file), its **SHA-256 fingerprint is denylisted** so it cannot be re-uploaded by another account, and the uploader is notified with the agent's address for a counter-notice.
- **Two notices terminate the account**: their remaining tracks are removed and the handle can no longer log in.
- An artist deleting their *own* upload is not a strike and does not poison the fingerprint — the same file may be re-uploaded.
- Set `OPENMIC_DMCA_EMAIL` to a real address before publishing anywhere public; it is printed on every takedown confirmation and on the community disclaimer.

Composing-side royalties are deliberately **out of scope**: OpenMic does not obtain mechanical licences (MLC in the US) or sign up for EU Art. 17 filtering. Covers therefore need the artist's own licence, which is exactly what the warranty and the assistant's cover warning exist to say.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5173` | Listen port |
| `OPENMIC_HOST` | `127.0.0.1` | Bind address; set `0.0.0.0` only behind a proxy you control |
| `OPENMIC_DMCA_EMAIL` | `dmca@openmic.invalid` | Designated agent contact |
| `OPENMIC_DATA_DIR` | `./data` | Account store + uploaded audio (git-ignored) |
| `OPENMIC_AI_KEY` / `OPENMIC_AI_MODEL` / `OPENMIC_AI_BASE_URL` | unset | Optional model proxy for the assistant |

### Privacy and persistence

Imported local songs stay in browser IndexedDB; saved favorites, playlists and link/stream metadata stay in browser localStorage. Free-source streams play from the upstream providers (who receive ordinary requests). Artist accounts, uploaded audio and login-failure counters live on the OpenMic server in `./data/`; nothing is sent to a third party unless you configure the optional assistant model, and even then only the artist's own draft text is forwarded. No tracking scripts, no payment information collection.

### Development

- `src/audius.mjs` — Audius search and stream URLs
- `src/providers.mjs` — Openverse, Wikimedia Commons, Radio Browser adapters + multi-source aggregator
- `src/free-catalog.mjs` — source selector, search, listings and pagination
- `src/app.mjs` — player, queues, local files, favorites and playlists
- `src/community-api.mjs` — browser client for the artist API, incl. track normalisation and stream-URL construction
- `src/artist.mjs` / `src/artist.css` — artist studio, community catalog, takedown dialog
- `src/dialogs.mjs` — shared confirm dialog promise used by both modules
- `server/server.mjs` — `node:http` entry point and static/API dispatch
- `server/api.mjs` — accounts, uploads, streaming, takedowns, assistant routes
- `server/users.mjs`, `server/store.mjs`, `server/static.mjs`, `server/ai.mjs` — credentials, JSON store, cache-correct file serving, assistant rules
- `tests/*.test.mjs` — deterministic fixtures; `tests/server.test.mjs` boots the real server

This application is independent of Spotify, Openverse, Audius, Wikimedia and Radio Browser and is not endorsed by those services. No scraping, DRM bypass, copyrighted catalog rehosting, premium-feature circumvention or licence-free cover distribution is part of this project. Artist uploads are published by the artists themselves under a rights warranty, and OpenMic removes them on a valid notice.

## License

[MIT](./LICENSE) for original application source code. Media accessed through the app carries its own copyright and license terms.
