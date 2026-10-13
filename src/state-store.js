import fs from "node:fs/promises";
import path from "node:path";

const EMPTY_STATE = {
  bootstrapped: false,
  processedGoalKeys: [],
  fixtureScans: {}
};

function normalizeState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new SyntaxError("Goal tracker state must be a JSON object");
  }
  return {
    ...EMPTY_STATE,
    ...state,
    processedGoalKeys: Array.isArray(state.processedGoalKeys) ? state.processedGoalKeys : [],
    fixtureScans: state.fixtureScans && typeof state.fixtureScans === "object" ? state.fixtureScans : {}
  };
}

async function readState(statePath) {
  return normalizeState(JSON.parse(await fs.readFile(statePath, "utf8")));
}

export async function loadState(dataDir) {
  const statePath = path.join(dataDir, "state.json");
  const backupPath = `${statePath}.bak`;
  try {
    return await readState(statePath);
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    try {
      const recovered = await readState(backupPath);
      console.warn(`Recovered goal tracker state from ${backupPath}`);
      return recovered;
    } catch (backupError) {
      if (error.code === "ENOENT" && backupError.code === "ENOENT") return structuredClone(EMPTY_STATE);
      throw error;
    }
  }
}

export async function saveState(dataDir, state) {
  await fs.mkdir(dataDir, { recursive: true });
  const statePath = path.join(dataDir, "state.json");
  const backupPath = `${statePath}.bak`;
  const temporaryPath = `${statePath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  try {
    await readState(statePath);
    await fs.copyFile(statePath, backupPath);
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  await fs.rename(temporaryPath, statePath);
}

export function rememberGoal(state, key) {
  if (!state.processedGoalKeys.includes(key)) state.processedGoalKeys.push(key);
  // A season has only a few hundred goals, but keeping a cap prevents an accidentally
  // corrupted provider response from growing the file without bound.
  state.processedGoalKeys = state.processedGoalKeys.slice(-2000);
}
