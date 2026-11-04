const http = require("node:http");
const { createHash, timingSafeEqual } = require("node:crypto");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const QRCode = require("qrcode");

try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const publicDirectory = path.join(__dirname, "public");
const teamLogoPattern = /^\/team-logos\/[a-z0-9-]+\.(?:svg|png|jpe?g|webp)$/i;
const contentFile = path.join(__dirname, "data", "quiz-content.json");
const stateFile = path.resolve(process.env.QUIZ_STATE_FILE || path.join(__dirname, ".quiz-state.json"));
const databasePool = process.env.DATABASE_URL
  ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 10_000,
  })
  : null;
databasePool?.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error);
});
const authUsername = process.env.QUIZ_AUTH_USERNAME ?? process.env.QUIZ_AUTH_USER;
const authPassword = process.env.QUIZ_AUTH_PASSWORD;
if (!authUsername || !authPassword || authUsername.includes(":") || authPassword.length < 8) {
  throw new Error("Set QUIZ_AUTH_USER (or QUIZ_AUTH_USERNAME) and a QUIZ_AUTH_PASSWORD of at least 8 characters.");
}
const authUsernameHash = createHash("sha256").update(authUsername).digest();
const authPasswordHash = createHash("sha256").update(authPassword).digest();
const files = {
  "/": { name: "index.html", type: "text/html; charset=utf-8" },
  "/admin": { name: "index.html", type: "text/html; charset=utf-8" },
  "/projector": { name: "projector.html", type: "text/html; charset=utf-8" },
  "/scores": { name: "scores.html", type: "text/html; charset=utf-8" },
  "/styles.css": { name: "styles.css", type: "text/css; charset=utf-8" },
  "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
  "/alarm.mp3": { name: "alarm.mp3", type: "audio/mpeg" },
  "/logo.svg": { name: "logo.png", type: "image/png; charset=utf-8" },
};

let content;
let state;
let revision = 0;
let teamColors;
let updateQueue = Promise.resolve();

function isAuthorized(authorization) {
  if (typeof authorization !== "string" || authorization.length > 8192) return false;
  const credentials = authorization.match(/^Basic\s+([A-Za-z\d+/]+={0,2})$/i)?.[1];
  if (!credentials) return false;

  const decoded = Buffer.from(credentials, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;

  const usernameMatches = timingSafeEqual(
    createHash("sha256").update(decoded.slice(0, separator)).digest(),
    authUsernameHash,
  );
  const passwordMatches = timingSafeEqual(
    createHash("sha256").update(decoded.slice(separator + 1)).digest(),
    authPasswordHash,
  );
  return usernameMatches && passwordMatches;
}

function isProtectedPath(pathname) {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  return normalizedPath === "/" || normalizedPath === "/admin" || normalizedPath === "/scores";
}

function acknowledgeUpdate(acknowledge, result) {
  if (typeof acknowledge === "function") acknowledge(result);
}

function projectorUrl(request) {
  const forwardedProtocol = request.headers["x-forwarded-proto"]?.split(",")[0].trim();
  const protocol = request.socket.encrypted || forwardedProtocol === "https" ? "https" : "http";
  const requestUrl = new URL(request.url, `${protocol}://${request.headers.host}`);
  const hostName = requestUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLoopback = hostName === "localhost" || hostName === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostName);

  if (isLoopback) {
    const addresses = Object.values(os.networkInterfaces()).flatMap((interfaces) => interfaces || [])
      .filter((address) => address.family === "IPv4" && !address.internal &&
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address));
    const lanAddress = addresses[0]?.address;
    if (lanAddress) requestUrl.hostname = lanAddress;
  }

  requestUrl.pathname = "/projector";
  requestUrl.search = "";
  requestUrl.hash = "";
  return requestUrl.toString();
}

function isValidContent(value) {
  return value && value.theme && typeof value.theme === "object" &&
    [value.theme.background, value.theme.panel, value.theme.text, value.theme.muted, value.theme.green, value.theme.blue]
      .every((color) => typeof color === "string" && /^#[\da-f]{6}$/i.test(color)) &&
    Array.isArray(value.theme.teamColors) && value.theme.teamColors.length > 0 &&
    value.theme.teamColors.every((color) => typeof color === "string" && /^#[\da-f]{6}$/i.test(color)) &&
    value.texts && typeof value.texts === "object" &&
    ["eventName", "adminEyebrow", "adminTitleBefore", "adminTitleAccent", "adminSubtitle",
      "projectorPrompt", "teamIntroEyebrow", "teamIntroCaption", "teamIntroHint", "scoreSubtitle"]
      .every((key) => typeof value.texts[key] === "string") &&
    Array.isArray(value.teams) && value.teams.length > 0 && value.teams.length <= 100 &&
    value.teams.every((team) => team && typeof team.id === "string" &&
      typeof team.name === "string" && team.name.length > 0 && team.name.length <= 24 &&
      Number.isSafeInteger(team.score) && team.score >= 0 &&
      (team.logo === undefined || (typeof team.logo === "string" && teamLogoPattern.test(team.logo))));
}

function newGameState() {
  return {
    teams: content.teams.map((team, index) => ({
      ...team,
      color: content.theme.teamColors[index % content.theme.teamColors.length],
      logo: team.logo ?? null,
      roundScores: [0, 0, 0, 0],
    })),
    roundNumber: 1,
    questionTimerDuration: 60,
    timerMode: "question",
    timerDuration: 60,
    timerRemaining: 60,
    timerEndsAt: null,
    spotlightTeamId: null,
    spotlightEndsAt: null,
    projectorQrVisible: false,
    teamIntroVisible: false,
    teamIntroIndex: 0,
  };
}

function serializeState(value) {
  const configuredTeamIds = new Set(content.teams.map((team) => team.id));
  const { teams, ...gameSettings } = value;
  return {
    ...gameSettings,
    teamScores: Object.fromEntries(
      teams.filter((team) => configuredTeamIds.has(team.id)).map((team) => [
        team.id,
        { total: team.score, rounds: team.roundScores },
      ]),
    ),
  };
}

async function restoreState() {
  content = JSON.parse(await readFile(contentFile, "utf8"));
  if (!isValidContent(content)) throw new Error("Quiz content file has an invalid format.");
  teamColors = new Set(content.theme.teamColors);
  state = newGameState();

  let savedState;
  if (databasePool) {
    await databasePool.query(`
      CREATE TABLE IF NOT EXISTS quiz_state (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const result = await databasePool.query("SELECT state FROM quiz_state WHERE id = 1");
    savedState = result.rows[0]?.state ?? null;
  } else {
    try {
      savedState = JSON.parse(await readFile(stateFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      savedState = null;
    }
  }

  if (savedState !== null) {
    if (!savedState || typeof savedState !== "object" || Array.isArray(savedState)) {
      throw new Error("Saved quiz state has an invalid format.");
    }
    const savedTeams = Array.isArray(savedState.teams) ? savedState.teams : [];
    const legacyScores = Object.fromEntries(savedTeams
      .filter((team) => team && typeof team.id === "string" && Number.isSafeInteger(team.score))
      .map((team) => [team.id, { total: team.score, rounds: team.roundScores }]));
    const savedScores = savedState.teamScores && typeof savedState.teamScores === "object" &&
      !Array.isArray(savedState.teamScores) ? savedState.teamScores : legacyScores;

    state = {
      ...state,
      roundNumber: savedState.roundNumber ?? state.roundNumber,
      questionTimerDuration: savedState.questionTimerDuration ??
        ([30, 45, 60].includes(savedState.timerDuration) ? savedState.timerDuration : state.questionTimerDuration),
      timerMode: savedState.timerMode ?? "question",
      timerDuration: savedState.timerDuration ?? state.timerDuration,
      timerRemaining: savedState.timerRemaining ?? state.timerRemaining,
      timerEndsAt: savedState.timerEndsAt ?? null,
      spotlightTeamId: savedState.spotlightTeamId ?? null,
      spotlightEndsAt: savedState.spotlightEndsAt ?? null,
      projectorQrVisible: savedState.projectorQrVisible ?? false,
      teamIntroVisible: savedState.teamIntroVisible ?? false,
      teamIntroIndex: savedState.teamIntroIndex ?? 0,
      teams: [
        ...content.teams.map((team, index) => ({
          ...team,
          color: teamColors.has(team.color) ? team.color : content.theme.teamColors[index % content.theme.teamColors.length],
          logo: team.logo ?? null,
          score: typeof savedScores[team.id] === "number"
            ? savedScores[team.id]
            : savedScores[team.id]?.total ?? team.score,
          roundScores: savedScores[team.id]?.rounds ?? [0, 0, 0, 0],
        })),
      ],
    };
    if (state.timerMode === "question" && state.timerDuration !== state.questionTimerDuration) {
      state.timerDuration = state.questionTimerDuration;
      state.timerRemaining = state.questionTimerDuration;
      state.timerEndsAt = null;
    }
    if (!isValidState(state)) throw new Error("Saved quiz state has an invalid format.");
  }

  await persistState(state);
}

async function persistState(value) {
  const savedState = serializeState(value);
  if (databasePool) {
    await databasePool.query(
      `INSERT INTO quiz_state (id, state, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [JSON.stringify(savedState)],
    );
    return;
  }
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(savedState), "utf8");
}

const stateReady = restoreState();

function isValidState(value) {
  return value && Array.isArray(value.teams) &&
    Number.isInteger(value.roundNumber) && value.roundNumber >= 1 && value.roundNumber <= 4 &&
    value.teams.length === content.teams.length &&
    value.teams.every((team, index) => team.id === content.teams[index].id) &&
    value.teams.length <= 100 &&
    value.teams.every((team) => team && typeof team.id === "string" &&
      typeof team.name === "string" && team.name.length > 0 && team.name.length <= 24 &&
      Number.isSafeInteger(team.score) && team.score >= 0 &&
      Array.isArray(team.roundScores) && team.roundScores.length === 4 &&
      team.roundScores.every((score) => Number.isSafeInteger(score) && score >= 0) &&
      team.score >= team.roundScores.reduce((total, score) => total + score, 0) &&
      (team.logo === null || (typeof team.logo === "string" && teamLogoPattern.test(team.logo))) &&
      typeof team.color === "string" && teamColors.has(team.color)) &&
    Number.isInteger(value.questionTimerDuration) &&
    value.questionTimerDuration >= 30 && value.questionTimerDuration <= 60 &&
    (value.timerMode === "question"
      ? value.timerDuration === value.questionTimerDuration
      : value.timerMode === "bonus" && value.timerDuration === 10) &&
    Number.isInteger(value.timerRemaining) && value.timerRemaining >= 0 &&
    value.timerRemaining <= value.timerDuration &&
    (value.timerEndsAt === null || Number.isFinite(value.timerEndsAt)) &&
    (value.spotlightTeamId === null || typeof value.spotlightTeamId === "string") &&
    (value.spotlightEndsAt === null || Number.isFinite(value.spotlightEndsAt)) &&
    typeof value.projectorQrVisible === "boolean" &&
    typeof value.teamIntroVisible === "boolean" &&
    Number.isInteger(value.teamIntroIndex) && value.teamIntroIndex >= 0 &&
    value.teamIntroIndex < value.teams.length;
}

const server = http.createServer(async (request, response) => {
  try {
    await stateReady;
  } catch (error) {
    console.error("Could not restore saved quiz state:", error);
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Unable to load saved quiz state.");
    return;
  }

  const pathname = new URL(request.url, "http://localhost").pathname;

  if (pathname === "/teams" && request.method === "GET") {
    response.writeHead(302, { Location: "/projector", "Cache-Control": "no-store" });
    response.end();
    return;
  }

  if (isProtectedPath(pathname) && !isAuthorized(request.headers.authorization)) {
    response.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Quiz Night", charset="UTF-8"',
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.end("Authentication required.");
    return;
  }

  if (pathname === "/api/content" && request.method === "GET") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(content));
    return;
  }

  if (pathname === "/api/projector-qr.svg" && request.method === "GET") {
    try {
      const qrSvg = await QRCode.toString(projectorUrl(request), {
        type: "svg",
        errorCorrectionLevel: "H",
        margin: 2,
        width: 512,
      });
      response.writeHead(200, {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(qrSvg);
    } catch (error) {
      console.error("Could not generate projector QR code:", error);
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Unable to generate projector QR code.");
    }
    return;
  }

  if (pathname === "/api/state" && request.method === "GET") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify({ state, revision }));
    return;
  }

  const logoFile = pathname.match(teamLogoPattern);
  const file = files[pathname] || (logoFile ? {
    name: path.join("team-logos", path.basename(pathname)),
    type: ({
      ".svg": "image/svg+xml; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
    })[path.extname(pathname).toLowerCase()],
  } : null);

  if (!file || request.method !== "GET") {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  try {
    const contents = await readFile(path.join(publicDirectory, file.name));
    response.writeHead(200, {
      "Content-Type": file.type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(contents);
  } catch (error) {
    console.error(`Could not read ${file.name}:`, error);
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Unable to load the quiz app.");
  }
});

const io = new Server(server);
io.on("connection", (socket) => {
  stateReady.then(() => {
    socket.emit("game:state", { state, revision });
  }).catch((error) => {
    console.error("Could not initialize quiz state for socket:", error);
    socket.emit("game:error", { error: "Unable to load quiz state." });
  });

  socket.on("game:update", (nextState, acknowledge) => {
    if (!isAuthorized(socket.handshake.headers.authorization)) {
      acknowledgeUpdate(acknowledge, { ok: false, error: "Authentication required to update the quiz." });
      return;
    }

    const update = updateQueue.then(async () => {
      if (!isValidState(nextState)) {
        acknowledgeUpdate(acknowledge, { ok: false, error: "Invalid quiz state." });
        return;
      }

      try {
        await persistState(nextState);
      } catch (error) {
        console.error("Could not save quiz state:", error);
        acknowledgeUpdate(acknowledge, { ok: false, error: "Unable to save quiz state." });
        return;
      }

      state = nextState;
      revision += 1;
      const payload = { state, revision };
      io.emit("game:state", payload);
      acknowledgeUpdate(acknowledge, { ok: true, revision });
    });

    updateQueue = update.catch((error) => {
      console.error("Could not process quiz update:", error);
      acknowledgeUpdate(acknowledge, { ok: false, error: "Unable to update quiz state." });
    });
  });
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  const storage = databasePool ? "PostgreSQL" : "local JSON file";
  console.log(`Quiz Night is running at http://localhost:${port} (${storage} state storage)`);
});
