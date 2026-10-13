const API_BASE_URL = "https://api.football-data.org/v4";

export class FootballDataClient {
  constructor(token, fetchImpl = globalThis.fetch) {
    this.token = token;
    this.fetch = fetchImpl;
  }

  async getMatches(competition, season, dateFrom, dateTo) {
    const url = new URL(`${API_BASE_URL}/competitions/${encodeURIComponent(competition)}/matches`);
    url.searchParams.set("season", String(season));
    url.searchParams.set("dateFrom", dateFrom);
    url.searchParams.set("dateTo", dateTo);

    const response = await this.fetch(url, {
      headers: {
        "X-Auth-Token": this.token,
        "X-Unfold-Goals": "true",
        "X-Unfold-Lineups": "true",
        "X-Unfold-Subs": "true",
        accept: "application/json"
      }
    });
    const body = await response.json();
    if (!response.ok) {
      const detail = body.message || body.error || response.statusText;
      throw new Error(`football-data.org ${response.status}: ${detail}`);
    }
    return (body.matches ?? []).map(normalizeMatch);
  }
}

export function normalizeMatch(match) {
  return {
    fixture: {
      id: match.id,
      date: match.utcDate,
      status: { short: match.status },
      substitutions: match.substitutions ?? []
    },
    teams: {
      home: {
        id: match.homeTeam?.id,
        name: match.homeTeam?.name ?? match.homeTeam?.shortName,
        lineup: match.homeTeam?.lineup ?? [],
        bench: match.homeTeam?.bench ?? []
      },
      away: {
        id: match.awayTeam?.id,
        name: match.awayTeam?.name ?? match.awayTeam?.shortName,
        lineup: match.awayTeam?.lineup ?? [],
        bench: match.awayTeam?.bench ?? []
      }
    },
    events: (match.goals ?? []).map((goal, index) => ({
      id: `${match.id}-${index}`,
      type: "Goal",
      detail: goal.type === "PENALTY" ? "Penalty" : "Normal Goal",
      time: { elapsed: goal.minute, extra: goal.injuryTime },
      team: goal.team,
      player: goal.scorer,
      assist: goal.assist
    }))
  };
}

function isPlayer(player, playerId) {
  if (!player) return false;
  if (playerId && player.id != null) return String(player.id) === String(playerId);
  return (player.name ?? "").toLowerCase().includes("haaland");
}

function isManchesterCity(team, cityTeamId = "65") {
  return String(team?.id ?? "") === String(cityTeamId)
    || (team?.name ?? "").toLowerCase().replace(/\s+fc$/, "").trim() === "manchester city";
}

export function isHaalandPlaying(fixture, playerId, cityTeamId = "65") {
  const status = fixture?.fixture?.status?.short;
  if (!new Set(["IN_PLAY", "PAUSED", "LIVE"]).has(status)) return false;

  const cityTeam = [fixture.teams?.home, fixture.teams?.away]
    .find((team) => isManchesterCity(team, cityTeamId));
  if (!cityTeam || !Array.isArray(cityTeam.lineup) || cityTeam.lineup.length === 0) return false;

  let onPitch = cityTeam.lineup.some((player) => isPlayer(player, playerId));
  for (const substitution of fixture.fixture.substitutions ?? []) {
    if (!isManchesterCity(substitution.team, cityTeamId)) continue;
    if (isPlayer(substitution.playerOut, playerId)) onPitch = false;
    if (isPlayer(substitution.playerIn, playerId)) onPitch = true;
  }
  return onPitch;
}

export function isHaalandGoal(event, playerId = null) {
  if (event?.type !== "Goal") return false;
  if (["Missed Penalty", "Missed Penalty - Saved"].includes(event.detail)) return false;
  const eventPlayerId = event.player?.id == null ? null : String(event.player.id);
  if (playerId) return eventPlayerId === String(playerId);
  return (event.player?.name ?? "").toLowerCase().includes("haaland");
}

export function goalKey(fixtureId, event, provider = "football-data") {
  return [
    provider,
    fixtureId,
    event.id ?? "?",
    event.time?.elapsed ?? "?",
    event.time?.extra ?? "",
    event.player?.id ?? event.player?.name ?? "?"
  ].join(":");
}

export function fixtureLabel(fixture) {
  return `${fixture.teams?.home?.name ?? "Home"} vs ${fixture.teams?.away?.name ?? "Away"}`;
}
