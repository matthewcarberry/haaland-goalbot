const API_BASE_URL = "https://v3.football.api-sports.io";

const STATUS_MAP = new Map([
  ["NS", "SCHEDULED"], ["TBD", "SCHEDULED"], ["1H", "IN_PLAY"],
  ["HT", "PAUSED"], ["2H", "IN_PLAY"], ["ET", "IN_PLAY"],
  ["BT", "PAUSED"], ["P", "PAUSED"], ["SUSP", "SUSPENDED"],
  ["FT", "FINISHED"], ["AET", "FINISHED"], ["PEN", "FINISHED"],
  ["PST", "POSTPONED"], ["CANC", "CANCELLED"], ["ABD", "SUSPENDED"],
  ["AWD", "FINISHED"], ["WO", "FINISHED"]
]);

const EVENT_POLL_START_MS = 2 * 60 * 1000;
const EVENT_POLL_END_MS = 120 * 60 * 1000;
const LINEUP_WINDOW_START_MS = 60 * 60 * 1000;
const LINEUP_RETRY_MS = 10 * 60 * 1000;
const SCHEDULE_CACHE_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class ApiFootballClient {
  constructor(apiKey, fetchImpl = globalThis.fetch, now = () => new Date(), { backfillDays = 0 } = {}) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.now = now;
    this.backfillDays = backfillDays;
    this.scheduleCache = new Map();
    this.fixtureCache = new Map();
    this.lineupAttempts = new Map();
  }

  async getMatches(leagueId, season, teamId) {
    const now = this.now();
    const cacheKey = `${leagueId}:${season}:${teamId}`;
    const cachedSchedule = this.scheduleCache.get(cacheKey);
    if (!cachedSchedule || now.getTime() - cachedSchedule.fetchedAt >= SCHEDULE_CACHE_MS) {
      await this.refreshSchedule(leagueId, season, teamId, now);
    }

    const fixtures = [];
    for (const rawFixture of this.scheduleCache.get(cacheKey)?.fixtures ?? []) {
      const kickoff = new Date(rawFixture.fixture?.date);
      if (Number.isNaN(kickoff.getTime())) continue;

      const age = now.getTime() - kickoff.getTime();
      const fixtureId = String(rawFixture.fixture.id);
      const fixture = this.fixtureCache.get(fixtureId) ?? normalizeFixture(rawFixture);
      fixture.fixture.status.short = derivedStatus(rawFixture.fixture?.status?.short, age);

      if (age >= -LINEUP_WINDOW_START_MS && age <= EVENT_POLL_END_MS) {
        await this.loadLineupsIfDue(fixture, now);
      }
      if (age >= -EVENT_POLL_START_MS && age <= EVENT_POLL_END_MS) {
        mergeEvents(fixture, await this.request("/fixtures/events", { fixture: rawFixture.fixture.id }));
      } else if (this.backfillDays > 0 && age >= 0 && age <= this.backfillDays * DAY_MS && !fixture._eventsLoaded) {
        mergeEvents(fixture, await this.request("/fixtures/events", { fixture: rawFixture.fixture.id }));
        fixture._eventsLoaded = true;
      }

      this.fixtureCache.set(fixtureId, fixture);
      fixtures.push(fixture);
    }
    return fixtures;
  }

  async refreshSchedule(leagueId, season, teamId, now) {
    const lookbackDays = Math.max(1, this.backfillDays);
    const from = dateOnly(new Date(now.getTime() - lookbackDays * DAY_MS));
    const to = dateOnly(new Date(now.getTime() + DAY_MS));
    const fixtures = await this.request("/fixtures", {
      league: leagueId, season, team: teamId, from, to
    });
    this.scheduleCache.set(`${leagueId}:${season}:${teamId}`, { fixtures, fetchedAt: now.getTime() });
  }

  async loadLineupsIfDue(fixture, now) {
    const fixtureId = String(fixture.fixture.id);
    const lastAttempt = this.lineupAttempts.get(fixtureId) ?? 0;
    if (fixture._lineupsLoaded || now.getTime() - lastAttempt < LINEUP_RETRY_MS) return;

    this.lineupAttempts.set(fixtureId, now.getTime());
    const lineups = await this.request("/fixtures/lineups", { fixture: fixture.fixture.id });
    mergeLineups(fixture, lineups);
    fixture._lineupsLoaded = lineups.length > 0;
  }

  async request(path, params) {
    const url = new URL(`${API_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.fetch(url, {
        headers: { "x-apisports-key": this.apiKey, accept: "application/json" },
        signal: controller.signal
      });
      const body = await response.json();
      const errors = Object.values(body.errors ?? {});
      if (!response.ok || errors.length > 0) {
        const detail = errors.join(", ") || body.message || response.statusText;
        throw new Error(`api-football.com ${response.status}: ${detail}`);
      }
      return body.response ?? [];
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function normalizeFixture(fixture) {
  return {
    fixture: {
      id: fixture.fixture?.id ?? fixture.id,
      date: fixture.fixture?.date,
      status: { short: normalizeStatus(fixture.fixture?.status?.short ?? fixture.status) },
      substitutions: []
    },
    teams: {
      home: normalizeTeam(fixture.teams?.home),
      away: normalizeTeam(fixture.teams?.away)
    },
    events: []
  };
}

function normalizeTeam(team) {
  return { id: team?.id, name: team?.name, lineup: [], bench: [] };
}

function mergeLineups(fixture, lineups) {
  for (const lineup of lineups) {
    const side = String(lineup.team?.id) === String(fixture.teams.home.id) ? fixture.teams.home : fixture.teams.away;
    if (!side?.id) continue;
    side.lineup = (lineup.startXI ?? []).map((entry) => normalizePlayer(entry.player ?? entry));
    side.bench = (lineup.substitutes ?? []).map((entry) => normalizePlayer(entry.player ?? entry));
  }
}

function mergeEvents(fixture, events) {
  fixture.events = events
    .map((event, index) => normalizeEvent(fixture.fixture.id, event, index))
    .filter(Boolean);
  fixture.fixture.substitutions = events
    .filter((event) => event.type?.toLowerCase() === "subst")
    .map((event) => ({
      team: event.team,
      playerOut: normalizePlayer(event.player),
      playerIn: normalizePlayer(event.assist)
    }));
}

function normalizeEvent(fixtureId, event, index) {
  if (event.type?.toLowerCase() !== "goal") return null;
  const player = normalizePlayer(event.player);
  return {
    id: `${fixtureId}-${index}-${event.time?.elapsed ?? "?"}-${player?.id ?? player?.name ?? "?"}`,
    type: "Goal",
    detail: event.detail,
    time: { elapsed: event.time?.elapsed, extra: event.time?.extra },
    team: event.team,
    player,
    assist: normalizePlayer(event.assist)
  };
}

function normalizePlayer(player) {
  return player ? { id: player.id, name: player.name } : null;
}

function normalizeStatus(status) {
  return STATUS_MAP.get(status) ?? status ?? "SCHEDULED";
}

function derivedStatus(status, age) {
  const normalized = normalizeStatus(status);
  if (["FINISHED", "POSTPONED", "CANCELLED", "SUSPENDED"].includes(normalized)) return normalized;
  if (age < -EVENT_POLL_START_MS) return "SCHEDULED";
  if (age <= EVENT_POLL_END_MS) return "IN_PLAY";
  return "FINISHED";
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}
