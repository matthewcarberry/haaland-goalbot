# Haaland Goal Tracker

A Discord bot that watches Premier League, EFL Cup, and UEFA Champions League fixture events and posts one random Erling Haaland GIF for each new goal.

## What it uses

- Discord.js for the bot connection and channel posts.
- API-Football for Manchester City Premier League, EFL Cup, and UEFA Champions League fixtures, live events, lineups, and substitutions.
- A local GIF library, direct GIF URL list, or Tenor for random GIF selection.
- `data/state.json` to avoid reposting the same goal after a restart.
- An optional Reddit OAuth worker that downloads matching direct video posts and builds a local WebP montage with bundled FFmpeg.

Users can manually trigger a celebration with `/goalbot goal`, or convert one Reddit post with `/goalbot reddit url:<Reddit post URL>`. Both commands work only inside the channel configured by `DISCORD_CHANNEL_ID`. Discord does not allow uppercase letters or a colon in chat-input command names, so `/GoalBot: GOAL` cannot be registered literally. If either command is used elsewhere, the bot sends only an ephemeral error visible to the invoking user.

## Setup

1. Install Node.js 20 or newer.
2. Create a Discord application and bot at the [Discord Developer Portal](https://discord.com/developers/applications). Invite it to your server with the `bot` scope and `View Channel`, `Send Messages`, `Attach Files`, and `Embed Links` permissions in the target channel.
3. Register for a free API key at [API-Football](https://dashboard.api-football.com/register).
4. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, and `API_FOOTBALL_KEY`.
5. Put local `.gif` and `.webp` files directly inside the `gifs` folder. The default `GIF_DIRECTORY=gifs` setting will include both formats. The bot uploads the selected local file to Discord and displays it in the embed. Local files and any configured `GIF_URLS` are combined into the random pool. Local files larger than `MAX_GIF_FILE_BYTES` (8 MiB by default) are skipped for Discord compatibility.

   If you want to use only local files, clear `GIF_URLS` and leave `TENOR_API_KEY` blank.

   You can also set `GIF_URLS` to a comma-separated collection of direct GIF URLs. Example:

   ```text
   GIF_URLS=https://cdn.example.com/haaland-1.gif,https://cdn.example.com/haaland-2.gif
   ```

   Alternatively, set `TENOR_API_KEY`. Tenor's current documentation says that new API clients are not being accepted, so local files are the dependable option.

6. The default `API_FOOTBALL_LEAGUE_IDS=39,48,2,5,10` tracks the Premier League, EFL Cup, UEFA Champions League, UEFA Nations League, and international friendlies. `API_FOOTBALL_TEAM_IDS=50,1090` tracks Manchester City and Norway. Set `DISCORD_GUILD_ID` to your server ID if you want `/goalbot goal` to appear immediately. If it is blank, the bot registers the command globally, which can take up to an hour to propagate.

7. Install and test:

   ```powershell
   npm install
   npm test
   npm start
   ```

8. Optional: create a Reddit OAuth application, then fill in `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` to enable the montage worker. The worker uses Reddit's authenticated API rather than anonymous page scraping. Leave both blank if you only want the goal tracker.

## Unraid deployment

The repository includes `Dockerfile`, `docker-compose.yml`, and `.env.unraid.example`. Copy the project to `/mnt/user/appdata/haaland-goal-tracker` on Unraid, copy `.env.unraid.example` to `.env`, fill in the private credentials, and copy the contents of `gifs/` into the share's `gifs/` folder. In Dockge, add the stack from that folder and choose **Compose Up**. The `unless-stopped` restart policy keeps the bot running across container restarts and Unraid reboots. The `gifs/` and `data/` folders are mounted outside the container so GIFs, Reddit clips, and goal state persist.

## Behavior and tuning

The default season is calculated automatically: August through December and January through June are assigned to the appropriate Premier League season start year. Set `PL_SEASON` manually if you want to track a different season.

The bot caches Manchester City's schedule separately for each configured API-Football competition, checks lineups once before kickoff, and polls live fixture events every 90 seconds. The schedule caches are refreshed every six hours, and event requests include goals and substitutions. API-Football player IDs are provider-specific; leave `API_FOOTBALL_PLAYER_ID` blank to match Haaland by name, or fill it with the ID returned by API-Football's player lookup.

On first launch, existing goals are marked as seen and suppressed so a new bot does not flood the channel. Set `BACKFILL_EXISTING_GOALS=true` and `BACKFILL_DAYS=7` if you want it to post unprocessed Haaland goals found during the previous seven days. Backfill events are fetched once per fixture, and `processedGoalKeys` prevents duplicate posts. You can enable this later and restart the bot; do not delete `data/state.json` unless you intentionally want to reset the bot's memory.

The bot only requests the Discord `Guilds` intent; it does not read message content. It does not need a database or a public web server.

When enabled, the Reddit worker checks `r/MCFC` and `r/soccer` every five minutes by default, but only while the API-Football match feed reports Manchester City as live and Haaland as part of the active lineup. It stops checking after a reported Haaland substitution, when the match ends, or whenever lineup status cannot be confirmed. New direct `.mp4` or `.webm` Reddit posts whose titles match `REDDIT_TITLE_PATTERN` are queued, but they are converted and posted only after the football feed detects a new Haaland goal. This also handles a clip uploaded shortly after the goal. Clips queued when the match closes or Haaland leaves are discarded. Because it selects posts by title, it assumes each matching Reddit post is already a Haaland clip; it does not identify Haaland inside a longer mixed highlight video with computer vision.
