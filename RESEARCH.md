# Reverse-engineering research notes — Spotify behavior

The supplied URL (`https://github.com/topics/reverse-engineer-anything`) is a GitHub **topic** listing; it does not contain a single ready-to-run repository.

Relevant REA project: https://github.com/morluto/rea (official project README describes `npx rea-agents setup` and tools for inspecting app behavior, JS, native binaries, websites, etc.).

## Clean-room observable UX to recreate

| Observed feature | Independent implementation |
|---|---|
| Library / liked songs | IndexedDB + localStorage with browser-only persistence |
| Queue and player | HTMLAudioElement + small queue state machine |
| Search | Local in-memory filtering |
| Playlist management | Per-user browser storage |
| Spotify content view | Spotify-approved iframe Embed (not a private stream endpoint) |

## Legal/technical boundary

Using the app, watching DOM changes and public interactions, or reading public developer docs is different from obtaining rights to Spotify's audio catalog. Spotify's Web Playback SDK requires Spotify Premium. API docs prohibit streaming downloads/ripping. We did not modify protected executables, defeat authentication/DRM, scrape private endpoints, or claim to provide Spotify Premium.

Useful sources:
- https://developer.spotify.com/documentation/web-playback-sdk/howtos/web-app-player/
- https://developer.spotify.com/documentation/embeds/tutorials/creating-an-embed
- https://developer.spotify.com/documentation/web-api/reference/get-track

## Reproducible REA investigation (separate optional local workflow)

If you want to analyze non-protected UI behaviors with REA on your own machine, read the [REA installation documentation](https://github.com/morluto/rea) and install from the project's documented official source. Focus on publicly observable features and clean-room rewrites. This prototype does not depend on installing REA.