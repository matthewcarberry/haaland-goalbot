import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { currentPremierLeagueSeason } from "../src/config.js";
import { ApiFootballClient } from "../src/api-football.js";
import { goalKey, isHaalandGoal, isHaalandPlaying, normalizeMatch } from "../src/football-data.js";
import { GifProvider } from "../src/gif-provider.js";
import { findRedditVideoUrl, isCandidatePost, RedditClient } from "../src/reddit-montage.js";
import { loadState, saveState } from "../src/state-store.js";

test("current Premier League season uses the season start year", () => {
  assert.equal(currentPremierLeagueSeason(new Date("2026-08-17T00:00:00Z")), 2026);
  assert.equal(currentPremierLeagueSeason(new Date("2027-02-01T00:00:00Z")), 2026);
  assert.equal(currentPremierLeagueSeason(new Date("2026-06-30T00:00:00Z")), 2025);
});

test("state store recovers from a truncated state file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "haaland-state-"));
  try {
    const original = { bootstrapped: true, processedGoalKeys: ["goal-1"], fixtureScans: { fixture: 1 } };
    await saveState(directory, original);
    await saveState(directory, { ...original, processedGoalKeys: ["goal-1", "goal-2"] });
    await fs.writeFile(path.join(directory, "state.json"), "", "utf8");

    const recovered = await loadState(directory);
    assert.deepEqual(recovered.processedGoalKeys, ["goal-1"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("only Haaland goal events are selected", () => {
  assert.equal(isHaalandGoal({ type: "Goal", detail: "Normal Goal", player: { name: "Erling Haaland" } }), true);
  assert.equal(isHaalandGoal({ type: "Goal", detail: "Missed Penalty", player: { name: "Erling Haaland" } }), false);
  assert.equal(isHaalandGoal({ type: "Card", player: { name: "Erling Haaland" } }), false);
  assert.equal(isHaalandGoal({ type: "Goal", player: { name: "Bukayo Saka" } }), false);
});

test("goal keys are stable and include the fixture", () => {
  const event = { id: "456-0", time: { elapsed: 20 }, player: { id: 1100 } };
  assert.equal(goalKey(456, event), "football-data:456:456-0:20::1100");
});

test("football-data.org goals normalize into the bot event shape", () => {
  const match = normalizeMatch({
    id: 456,
    utcDate: "2026-08-21T19:00:00Z",
    status: "IN_PLAY",
    homeTeam: { id: 1, name: "Manchester City" },
    awayTeam: { id: 2, name: "Liverpool" },
    goals: [{ minute: 27, injuryTime: null, type: "REGULAR", team: { id: 1, name: "Manchester City" }, scorer: { id: 1100, name: "Erling Haaland" }, assist: null }]
  });
  assert.equal(match.teams.home.name, "Manchester City");
  assert.equal(match.events[0].player.name, "Erling Haaland");
  assert.equal(match.events[0].time.elapsed, 27);
});

test("API-Football client caches schedule and normalizes live events", async () => {
  const calls = [];
  const now = new Date("2026-08-28T20:00:00Z");
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const path = new URL(url).pathname;
    const response = path.endsWith("/fixtures")
      ? [{ fixture: { id: 789, date: "2026-08-28T19:00:00Z", status: { short: "NS" } }, teams: { home: { id: 50, name: "Manchester City" }, away: { id: 2, name: "Liverpool" } } }]
      : path.endsWith("/fixtures/lineups")
        ? [{ team: { id: 50 }, startXI: [{ player: { id: 1100, name: "Erling Haaland" } }], substitutes: [] }]
        : [{ time: { elapsed: 65, extra: null }, team: { id: 50, name: "Manchester City" }, player: { id: 1100, name: "Erling Haaland" }, assist: null, type: "Goal", detail: "Normal Goal" }, { time: { elapsed: 75, extra: null }, team: { id: 50, name: "Manchester City" }, player: { id: 1100, name: "Erling Haaland" }, assist: { id: 999, name: "Substitute" }, type: "subst", detail: "Substitution" }];
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ response }) };
  };

  const client = new ApiFootballClient("test-key", fetchImpl, () => now);
  const fixtures = await client.getMatches(39, 2026, 50);
  assert.equal(fixtures[0].fixture.status.short, "IN_PLAY");
  assert.equal(fixtures[0].events.length, 1);
  assert.equal(isHaalandGoal(fixtures[0].events[0], "1100"), true);
  assert.equal(isHaalandPlaying(fixtures[0], "1100", "50"), false);

  await client.getMatches(39, 2026, 50);
  assert.equal(calls.filter((url) => new URL(url).pathname === "/fixtures").length, 1);
  assert.equal(calls.filter((url) => url.includes("/fixtures/lineups")).length, 1);
  assert.equal(calls.filter((url) => url.includes("/fixtures/events")).length, 2);
});

test("API-Football client can backfill historical fixture events once", async () => {
  const calls = [];
  const now = new Date("2026-09-02T12:00:00Z");
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const parsed = new URL(url);
    const response = parsed.pathname.endsWith("/fixtures")
      ? [{ fixture: { id: 790, date: "2026-08-30T15:00:00Z", status: { short: "FT" } }, teams: { home: { id: 50, name: "Manchester City" }, away: { id: 2, name: "Liverpool" } } }]
      : [{ time: { elapsed: 11, extra: null }, team: { id: 50, name: "Manchester City" }, player: { id: 1100, name: "Erling Haaland" }, assist: null, type: "Goal", detail: "Normal Goal" }];
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ response }) };
  };

  const client = new ApiFootballClient("test-key", fetchImpl, () => now, { backfillDays: 7 });
  const fixtures = await client.getMatches(39, 2026, 50);
  assert.equal(fixtures[0].events.length, 1);
  assert.equal(isHaalandGoal(fixtures[0].events[0], "1100"), true);
  assert.match(calls.find((url) => new URL(url).pathname === "/fixtures"), /from=2026-08-26/);

  await client.getMatches(39, 2026, 50);
  assert.equal(calls.filter((url) => url.includes("/fixtures/events")).length, 1);
});

test("API-Football client keeps separate caches for multiple competitions", async () => {
  const calls = [];
  const now = new Date("2026-09-17T12:00:00Z");
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const parsed = new URL(url);
    const response = parsed.pathname.endsWith("/fixtures")
      ? [{ fixture: { id: Number(parsed.searchParams.get("league")), date: "2026-09-17T18:30:00Z", status: { short: "NS" } }, teams: { home: { id: 50, name: "Manchester City" }, away: { id: 2, name: "Norwich" } } }]
      : [];
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ response }) };
  };

  const client = new ApiFootballClient("test-key", fetchImpl, () => now);
  assert.equal((await client.getMatches(39, 2026, 50))[0].fixture.id, 39);
  assert.equal((await client.getMatches(48, 2026, 50))[0].fixture.id, 48);
  assert.equal(calls.filter((url) => new URL(url).pathname === "/fixtures").length, 2);
});

test("Reddit monitoring is allowed only while Haaland is on the pitch for a live City match", () => {
  const fixture = {
    fixture: { status: { short: "IN_PLAY" }, substitutions: [] },
    teams: {
      home: { id: 65, name: "Manchester City", lineup: [{ id: 38101, name: "Erling Haaland" }] },
      away: { id: 2, name: "Liverpool", lineup: [] }
    }
  };
  assert.equal(isHaalandPlaying(fixture, "38101"), true);

  fixture.fixture.substitutions = [{
    team: { id: 65, name: "Manchester City" },
    playerOut: { id: 38101, name: "Erling Haaland" },
    playerIn: { id: 999, name: "Substitute" }
  }];
  assert.equal(isHaalandPlaying(fixture, "38101"), false);

  fixture.fixture.status.short = "FINISHED";
  assert.equal(isHaalandPlaying(fixture, "38101"), false);
});

test("GIF list provider chooses from configured URLs", async () => {
  const provider = new GifProvider({ gifUrls: ["https://example.com/a.gif", "https://example.com/b.gif"] }, undefined, () => 0.99);
  const gif = await provider.randomGif();
  assert.equal(gif.url, "https://example.com/b.gif");
});

test("local provider includes GIF and animated WebP files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "haaland-gifs-"));
  try {
    await fs.writeFile(path.join(directory, "celebration.gif"), "gif");
    await fs.writeFile(path.join(directory, "celebration.webp"), "webp");
    await fs.writeFile(path.join(directory, "ignore.txt"), "text");

    const provider = new GifProvider({ gifDirectory: directory, gifUrls: [] }, undefined, () => 0.99);
    const gif = await provider.randomGif();
    assert.equal(gif.attachmentName, "celebration.webp");
    assert.equal(gif.provider, "local GIF library");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("local provider skips files above the Discord upload limit", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "haaland-gifs-limit-"));
  try {
    await fs.writeFile(path.join(directory, "small.gif"), "gif");
    await fs.writeFile(path.join(directory, "large.gif"), "12345678901");

    const provider = new GifProvider({ gifDirectory: directory, gifUrls: [], maxGifFileBytes: 10 }, undefined, () => 0.99);
    const gif = await provider.randomGif();
    assert.equal(gif.attachmentName, "small.gif");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Reddit montage candidates require a matching title and direct video URL", () => {
  const post = {
    id: "abc123",
    title: "Erling Haaland scores for Manchester City",
    secure_media: {
      reddit_video: { fallback_url: "https://v.redd.it/abc123/DASH_720.mp4?source=fallback" }
    }
  };

  assert.equal(findRedditVideoUrl(post), "https://v.redd.it/abc123/DASH_720.mp4?source=fallback");
  assert.equal(isCandidatePost(post, "haaland|erling"), true);
  assert.equal(isCandidatePost({ ...post, title: "Unrelated match" }, "haaland|erling"), false);
});

test("Reddit client resolves a post URL through OAuth", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("access_token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "test-token", expires_in: 3600 }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => [{ data: { children: [{ data: { id: "abc123", title: "1-0 Haaland 11'" } }] } }]
    };
  };
  const client = new RedditClient({ redditClientId: "id", redditClientSecret: "secret", redditUserAgent: "test-agent" }, fetchImpl);
  const post = await client.postByUrl("https://www.reddit.com/r/MCFC/comments/abc123/haaland_goal/");
  assert.equal(post.data.id, "abc123");
  assert.equal(post.data.title, "1-0 Haaland 11'");
});
