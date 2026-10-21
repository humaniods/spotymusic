# SpotBridge — local music + official Spotify embeds

**An independent, local-first music library with a familiar modern music-player experience.** It is not Spotify Premium, and it does not unlock, scrape, download, decrypt or redistribute Spotify's catalog.

## Start

Requirements: a modern browser, Python 3 to serve static files, and optionally Node 18+ for tests.

```bash
cd spotbridge
python3 -m http.server 5173
# Open http://localhost:5173
```

To run automated unit tests:

```bash
npm test
```


## Free online music (Audius)

The **Free Music** tab now offers independent artists' newly released tracks, weekly trending tracks, and song/artist search, powered by the public [Audius API](https://docs.audius.co/api/). Click a track to stream it through the existing player; shuffle, seek, repeat and volume work as for local audio. Likes and playlist additions are saved locally and reloaded the next time you open the app.

**Costs:** SpotyMusic has no checkout, subscription, payment gateway, billing or paid plans. Streaming on Audius uses the provider's openly streamable tracks, and this app intentionally excludes recordings marked unavailable or paywalled by Audius. You do not need a Spotify Premium subscription to play these Audius tracks.

**Catalog limitation:** Audius is **not** a mirror of Spotify's licensed catalog. Latest means latest releases *on Audius*, not every new Bollywood, Punjabi, Hindi or international commercial hit. Some artists and tracks will not exist there. Spotify links still open in Spotify's official embeds and obey Spotify's limitations. Do not claim universal free access to Spotify's music.

**Network:** Free Music requires an internet connection and Audius API availability. The API currently documents read-only public access, but rate limits, region restrictions, browser playback or upstream policy changes may affect specific songs. If the feed fails to load, the app shows an error and allows retrying. No secret is bundled with frontend code.

## What works

- Play three original, browser-synthesized demonstration tracks with progress controls, volume, queue, shuffle and repeat.
- Upload MP3, AAC, M4A, FLAC (depending on browser codec support), OGG, WAV etc. Files are kept in your browser's IndexedDB, not uploaded to any server.
- Create collections, like songs and add songs/Spotify links to playlists. Library, likes and playlists persist locally.
- Search all saved items, import via file picker or drag-and-drop.
- Save a Spotify track/album/playlist/artist/episode/show URL or Spotify URI, and open it through an **official Spotify embed**. This is an official embedded player, not reverse-engineered streaming.
- Responsive desktop/mobile layout.

## What's deliberately not included

- No Spotify DRM removal, Premium entitlement bypass, ad blocking/bypass, downloaded Spotify streams, private API automation, or unauthorized use of copyrighted Spotify audio.
- Spotify embeds may show a shortened preview or require account login depending on user, territory and content. Ads and limitations are controlled by Spotify.
- Local audio filenames are displayed as song names; ID3 album-art extraction is not implemented.
- Metadata for a Spotify link defaults to its content type and ID; you can provide a useful title when adding it.

## Privacy

Local files are stored in IndexedDB (`spotbridge-music`). Playlist and saved-link data is stored in `localStorage`, all within your browser's origin. The app has no backend, telemetry or account system. Official Spotify embeds contact Spotify domains. Google Fonts are optional network dependencies with system-font fallback.

## Reverse-engineering methodology

The GitHub topic URL supplied by the user is a topic listing, *not* an app template. The REA project describes agent-assisted analysis of app behavior. See [RESEARCH.md](./RESEARCH.md) for a scope distinction and reproducible, lawful investigation guide. This project implements a clean-room music player from observable user-facing behavior; **REA was not run against Spotify executables or binaries here.**

## License

Original UI and source code authored for this prototype. The short instrumental demos are synthesized in the browser from original code, with no third-party audio hosting. Spotify is a trademark of Spotify AB; this project is independent and unaffiliated.

## Repository and development

Repository: https://github.com/humaniods/spotymusic

This project includes GitHub Actions tests. To contribute, clone the repository, make your changes on a branch, run `npm test`, and open a pull request.

Demo tracks are generated locally at runtime by `src/demo-audio.mjs` as PCM WAV. They are placeholders, not Spotify catalog audio.