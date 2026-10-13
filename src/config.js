import path from "node:path";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function integer(name, fallback, minimum) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function integerList(name, fallback, minimum) {
  const raw = process.env[name]?.trim() || fallback;
  const values = raw.split(",").map((value) => Number.parseInt(value.trim(), 10));
  if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value < minimum)) {
    throw new Error(`${name} must be a comma-separated list of integers >= ${minimum}`);
  }
  return [...new Set(values)];
}

export function currentPremierLeagueSeason(date = new Date()) {
  const year = date.getUTCFullYear();
  return date.getUTCMonth() >= 6 ? year : year - 1;
}

export function loadConfig() {
  const gifUrls = (process.env.GIF_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

  const gifDirectory = process.env.GIF_DIRECTORY?.trim()
    ? path.resolve(process.env.GIF_DIRECTORY.trim())
    : null;

  const apiFootballLeagueId = integer("API_FOOTBALL_LEAGUE_ID", 39, 1);
  const manchesterCityTeamId = process.env.API_FOOTBALL_TEAM_ID?.trim() || "50";
  const config = {
    discordToken: required("DISCORD_TOKEN"),
    discordChannelId: required("DISCORD_CHANNEL_ID"),
    discordGuildId: process.env.DISCORD_GUILD_ID?.trim() || null,
    apiFootballKey: required("API_FOOTBALL_KEY"),
    apiFootballLeagueId,
    apiFootballLeagueIds: integerList("API_FOOTBALL_LEAGUE_IDS", String(apiFootballLeagueId), 1),
    season: integer("PL_SEASON", currentPremierLeagueSeason(), 2000),
    apiFootballPlayerId: process.env.API_FOOTBALL_PLAYER_ID?.trim() || null,
    manchesterCityTeamId,
    apiFootballTeamIds: integerList("API_FOOTBALL_TEAM_IDS", manchesterCityTeamId, 1),
    gifDirectory,
    gifUrls,
    tenorApiKey: process.env.TENOR_API_KEY?.trim() || null,
    tenorClientKey: process.env.TENOR_CLIENT_KEY?.trim() || "haaland-goal-tracker",
    tenorQuery: process.env.TENOR_QUERY?.trim() || "Erling Haaland goal celebration football",
    pollIntervalSeconds: integer("POLL_INTERVAL_SECONDS", 90, 15),
    maxGifFileBytes: integer("MAX_GIF_FILE_BYTES", 8 * 1024 * 1024, 1),
    dataDir: path.resolve(process.env.DATA_DIR?.trim() || "data"),
    backfillExistingGoals: /^true$/i.test(process.env.BACKFILL_EXISTING_GOALS?.trim() || "false"),
    backfillDays: integer("BACKFILL_DAYS", 7, 1)
  };

  config.redditClientId = process.env.REDDIT_CLIENT_ID?.trim() || null;
  config.redditClientSecret = process.env.REDDIT_CLIENT_SECRET?.trim() || null;
  config.redditUserAgent = process.env.REDDIT_USER_AGENT?.trim() || "haaland-goal-bot/1.0";
  config.redditSubreddits = (process.env.REDDIT_SUBREDDITS || "MCFC,soccer")
    .split(",")
    .map((name) => name.trim().replace(/^r\//i, ""))
    .filter(Boolean);
  config.redditTitlePattern = process.env.REDDIT_TITLE_PATTERN?.trim() || "haaland|erling|manchester city|man city";
  config.redditPollIntervalSeconds = integer("REDDIT_POLL_INTERVAL_SECONDS", 300, 60);
  config.redditClipDirectory = path.resolve(process.env.REDDIT_CLIP_DIRECTORY?.trim() || "data/reddit-clips");
  config.redditMontageFormat = /^gif$/i.test(process.env.REDDIT_MONTAGE_FORMAT?.trim() || "webp") ? "gif" : "webp";
  config.redditMaxClips = integer("REDDIT_MAX_CLIPS", 20, 1);
  config.redditMontageMaxSeconds = integer("REDDIT_MONTAGE_MAX_SECONDS", 60, 1);
  config.redditEnabled = Boolean(config.redditClientId && config.redditClientSecret);

  if (!config.gifDirectory && config.gifUrls.length === 0 && !config.tenorApiKey) {
    throw new Error("Configure GIF_DIRECTORY, GIF_URLS, or TENOR_API_KEY so the bot can post a GIF.");
  }

  return config;
}
