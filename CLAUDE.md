# Haaland Goalbot

Node 20 Discord bot (discord.js 14, ES modules, no TypeScript, no database). It polls API-Football for
Manchester City (team 50) and Norway (1090) fixtures and posts a random Haaland GIF from `gifs/` when he scores.

- Run `npm test` (node:test, mocked fetch, no network) before every PR, and add a test for each behavior change.
- All config is env vars read in `src/config.js`. Document new ones in `.env.example`, `.env.unraid.example` and the README.
- Never commit `.env`, `data/state.json`, GIFs or real tokens. Never suggest deleting `state.json` to fix duplicates:
  first-run suppression and `processedGoalKeys` exist to stop channel floods.
- Haaland is matched by name unless `API_FOOTBALL_PLAYER_ID` is set; API-Football IDs are provider-specific.
- Discord limits: the slash command must stay lowercase `/goalbot` with subcommands, uploads over 8 MiB are skipped,
  and only the `Guilds` intent is used. Tenor no longer accepts new clients, so local `gifs/` is the main source.
- Respect the API-Football free-tier quota: keep the 6 h schedule cache and 90 s live polling unless asked.
- Deployment is Docker on Unraid via Dockge. Keep `Dockerfile`, `docker-compose.yml` and the `/app` paths working.
- `src/football-data.js` is the old football-data.org provider, but its helpers are still used; move them before deleting it.
