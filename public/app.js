let content;
let defaultTeams = [];
let teamColors = [];
let initialState;

const $ = (selector) => document.querySelector(selector);
const page = document.body.dataset.page;
let state;
let revision = -1;
let hasLoadedState = false;
let socket;
let toastTimeout = null;
let applauseEnabled = false;
let confettiAnimationFrame = null;
let lastIntroVisible = false;
let lastIntroIndex = -1;
let lastWinnerVisible = false;
let lastWinnerTeamId = null;
let lastTimerObservation = null;
let timerSoundEnabled = false;
let roundSpeechEnabled = false;
let lastRenderedRound = null;
let lastScoreRound = null;

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function announceSync(status) {
  document.querySelectorAll("[data-sync-status]").forEach((element) => {
    element.textContent = status;
  });
}

async function loadContent() {
  const response = await fetch("/api/content");
  if (!response.ok) throw new Error(`Could not load quiz content (${response.status}).`);
  content = await response.json();
  if (!Array.isArray(content.teams) || !Array.isArray(content.theme?.teamColors) ||
      content.theme.teamColors.length === 0 || !content.texts) {
    throw new Error("Quiz content is missing teams, theme, or text.");
  }

  teamColors = content.theme.teamColors;
  defaultTeams = content.teams.map((team, index) => ({
    ...team,
    color: teamColors.includes(team.color) ? team.color : teamColors[index % teamColors.length],
    logo: team.logo ?? null,
    roundScores: [0, 0, 0, 0],
  }));
  initialState = {
    teams: defaultTeams.map((team) => ({ ...team })),
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
    winnerVisible: false,
    winnerTeamId: null,
  };
  state = initialState;

  const root = document.documentElement;
  root.style.setProperty("--background", content.theme.background);
  root.style.setProperty("--panel", content.theme.panel);
  root.style.setProperty("--text", content.theme.text);
  root.style.setProperty("--muted", content.theme.muted);
  root.style.setProperty("--green", content.theme.green);
  root.style.setProperty("--blue", content.theme.blue);
  document.querySelectorAll("[data-copy]").forEach((element) => {
    const text = content.texts[element.dataset.copy];
    if (typeof text === "string") element.textContent = text;
  });
}

function showToast(message) {
  const toast = $("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function setState(nextState, persist = true) {
  if (persist && (!hasLoadedState || !socket?.connected)) {
    showToast("Wait for the LIVE connection before making changes.");
    return;
  }
  state = nextState;
  render();
  if (persist) void saveState();
}

function saveState() {
  if (!socket?.connected) {
    announceSync("OFFLINE");
    showToast("Couldn't sync changes. Check the server connection.");
    return;
  }

  socket.emit("game:update", state, (result) => {
    if (!result?.ok) {
      console.error("Could not sync quiz state:", result?.error || "No update acknowledgment received.");
      showToast(result?.error || "Couldn't sync changes. Check the server connection.");
      return;
    }
    announceSync("LIVE");
  });
}

function applyServerState(payload) {
  if (!payload || !Number.isInteger(payload.revision) || !payload.state) return;
  if (hasLoadedState && payload.revision <= revision) return;
  hasLoadedState = true;
  revision = payload.revision;
  state = payload.state;
  render();
  announceSync("LIVE");
}

function connectToGame() {
  socket = io();
  socket.on("connect", () => {
    revision = -1;
    hasLoadedState = false;
    announceSync("SYNCING");
    renderScores();
  });
  socket.on("disconnect", () => {
    revision = -1;
    hasLoadedState = false;
    announceSync("RECONNECTING");
    renderScores();
  });
  socket.on("connect_error", (error) => {
    console.error("Could not connect to quiz server:", error);
    revision = -1;
    hasLoadedState = false;
    announceSync("OFFLINE");
    renderScores();
  });
  socket.on("game:error", (result) => {
    console.error("Quiz server error:", result.error);
    announceSync("ERROR");
    showToast(result.error);
  });
  socket.on("game:state", (payload) => {
    applyServerState(payload);
  });
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function remainingSeconds() {
  if (state.timerEndsAt === null) return state.timerRemaining;
  return Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000));
}

function updateTimerElements(display, progress, status) {
  if (!display || !progress || !status) return;
  const remaining = remainingSeconds();
  const [minutes, seconds] = formatTime(remaining).split(":");
  display.innerHTML = `${minutes}<span>:</span>${seconds}`;
  display.setAttribute("aria-label", `${Math.floor(remaining / 60)} minutes ${remaining % 60} seconds`);
  progress.style.width = `${state.timerDuration ? (remaining / state.timerDuration) * 100 : 0}%`;
  const urgent = remaining <= 10 && remaining > 0;
  display.classList.toggle("is-urgent", urgent);
  progress.classList.toggle("is-urgent", urgent);
  const isRunning = state.timerEndsAt !== null && remaining > 0;
  const isFinished = state.timerEndsAt !== null && remaining === 0;
  status.textContent = isFinished ? "TIME'S UP" : isRunning ? "IN PROGRESS" : "READY";
  status.classList.toggle("is-running", isRunning);
  status.classList.toggle("is-finished", isFinished);

  const toggle = $("#timer-toggle");
  if (toggle) {
    toggle.querySelector(".play-icon").classList.toggle("hidden", isRunning);
    toggle.querySelector(".pause-icon").classList.toggle("hidden", !isRunning);
    toggle.querySelector("span").textContent = isRunning ? "Pause timer" : isFinished ? "Start again" : "Start timer";
  }
}

function playTimerSound() {
  const timerAudio = $("#timer-alarm");
  if (!timerAudio || !timerSoundEnabled) {
    console.error("Could not play the time-up sound because alarm.mp3 is unavailable or not enabled.");
    const soundStatus = $("#timer-sound-status");
    if (soundStatus) soundStatus.textContent = "Time-up sound is unavailable";
    return;
  }

  timerAudio.currentTime = 0;
  void timerAudio.play().catch((error) => {
    timerSoundEnabled = false;
    console.error("Could not play the time-up MP3:", error);
    const soundToggle = $("#timer-sound-toggle");
    const soundStatus = $("#timer-sound-status");
    if (soundToggle) {
      soundToggle.setAttribute("aria-pressed", "false");
      soundToggle.textContent = "Enable sound";
    }
    if (soundStatus) soundStatus.textContent = "Could not play the time-up sound";
  });
}

async function enableTimerSound() {
  if (page !== "projector") return;
  const timerAudio = $("#timer-alarm");
  if (!timerAudio) {
    console.error("Could not enable the time-up sound because the alarm audio element is missing.");
    const soundStatus = $("#timer-sound-status");
    if (soundStatus) soundStatus.textContent = "Time-up sound is unavailable";
    return;
  }

  timerAudio.muted = true;
  timerAudio.currentTime = 0;
  try {
    await timerAudio.play();
    timerAudio.pause();
    timerAudio.currentTime = 0;
    timerAudio.muted = false;
    timerSoundEnabled = true;
    roundSpeechEnabled = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
    const soundToggle = $("#timer-sound-toggle");
    const soundStatus = $("#timer-sound-status");
    if (soundToggle) {
      soundToggle.setAttribute("aria-pressed", "true");
      soundToggle.textContent = "Sound on";
    }
    if (soundStatus) soundStatus.textContent = roundSpeechEnabled
      ? "Time-up sound and spoken round announcements are enabled on this device."
      : "Time-up sound is enabled; spoken round announcements are unavailable in this browser.";
    if (roundSpeechEnabled) announceRound(state.roundNumber);
  } catch (error) {
    timerAudio.pause();
    timerAudio.muted = false;
    timerSoundEnabled = false;
    console.error("Could not enable time-up MP3:", error);
    const soundToggle = $("#timer-sound-toggle");
    if (soundToggle) {
      soundToggle.setAttribute("aria-pressed", "false");
      soundToggle.textContent = "Enable sound";
    }
    const soundStatus = $("#timer-sound-status");
    if (soundStatus) soundStatus.textContent = timerAudio.error
      ? "Could not load public/alarm.mp3"
      : "Could not enable sound";
  }
}

function playApplause() {
  if (!applauseEnabled) return;
  const applauseAudio = $("#applause-audio");
  if (!applauseAudio) {
    console.error("Could not play applause because the applause audio element is missing.");
    showToast("Applause audio is unavailable.");
    return;
  }

  applauseAudio.currentTime = 0;
  void applauseAudio.play().catch((error) => {
    applauseEnabled = false;
    applauseAudio.pause();
    console.error("Could not play the applause MP3:", error);
    const applauseToggle = $("#intro-applause-toggle");
    if (applauseToggle) {
      applauseToggle.textContent = "Enable applause";
      applauseToggle.setAttribute("aria-pressed", "false");
    }
    showToast("Couldn't play applause. Enable it again on the projector.");
  });
}

async function enableApplause() {
  const applauseAudio = $("#applause-audio");
  const applauseToggle = $("#intro-applause-toggle");
  if (!applauseAudio) {
    console.error("Could not enable applause because the applause audio element is missing.");
    const button = $("#intro-applause-toggle");
    if (button) button.textContent = "Applause unavailable";
    return;
  }

  if (applauseEnabled) {
    applauseAudio.pause();
    applauseAudio.currentTime = 0;
    applauseEnabled = false;
    if (applauseToggle) {
      applauseToggle.textContent = "Enable applause";
      applauseToggle.setAttribute("aria-pressed", "false");
    }
    return;
  }

  applauseAudio.currentTime = 0;
  try {
    await applauseAudio.play();
    applauseEnabled = true;
    if (applauseToggle) {
      applauseToggle.textContent = "Applause on";
      applauseToggle.setAttribute("aria-pressed", "true");
    }
  } catch (error) {
    applauseAudio.pause();
    applauseEnabled = false;
    console.error("Could not enable applause MP3:", error);
    if (applauseToggle) {
      applauseToggle.textContent = "Enable applause";
      applauseToggle.setAttribute("aria-pressed", "false");
    }
    showToast(applauseAudio.error
      ? "Could not load public/applause.mp3."
      : "Couldn't enable applause in this browser.");
  }
}

function launchIntroConfetti(canvasSelector = "#team-intro-confetti") {
  const canvas = $(canvasSelector);
  if (!canvas || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const context = canvas.getContext("2d");
  if (!context) return;

  if (confettiAnimationFrame !== null) cancelAnimationFrame(confettiAnimationFrame);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = width * pixelRatio;
  canvas.height = height * pixelRatio;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

  const colors = ["#012b72", "#15803d", "#4ade80", "#60a5fa", "#fbbf24", "#fb7185"];
  const pieces = Array.from({ length: 130 }, () => ({
    x: Math.random() * width,
    y: -Math.random() * height * 0.6,
    speedX: (Math.random() - 0.5) * 3,
    speedY: 2 + Math.random() * 4,
    rotation: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.18,
    size: 4 + Math.random() * 7,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const startedAt = performance.now();

  function drawConfetti(now) {
    context.clearRect(0, 0, width, height);
    for (const piece of pieces) {
      piece.x += piece.speedX;
      piece.y += piece.speedY;
      piece.speedY += 0.035;
      piece.rotation += piece.spin;
      context.save();
      context.translate(piece.x, piece.y);
      context.rotate(piece.rotation);
      context.fillStyle = piece.color;
      context.fillRect(-piece.size / 2, -piece.size / 2, piece.size, piece.size * 0.65);
      context.restore();
    }

    if (now - startedAt < 2400) {
      confettiAnimationFrame = requestAnimationFrame(drawConfetti);
    } else {
      context.clearRect(0, 0, width, height);
      confettiAnimationFrame = null;
    }
  }

  confettiAnimationFrame = requestAnimationFrame(drawConfetti);
}

function announceRound(roundNumber) {
  if (!roundSpeechEnabled) return;
  const roundNames = ["one", "two", "three", "four"];
  const announcement = new SpeechSynthesisUtterance(`Round ${roundNames[roundNumber - 1]}`);
  announcement.lang = document.documentElement.lang || "en";
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(announcement);
}

function renderTimer() {
  const remaining = remainingSeconds();
  if (page === "projector" && timerSoundEnabled && lastTimerObservation &&
      lastTimerObservation.timerEndsAt !== null &&
      lastTimerObservation.remaining > 0 &&
      state.timerEndsAt === lastTimerObservation.timerEndsAt &&
      remaining === 0) {
    playTimerSound();
  }
  lastTimerObservation = { timerEndsAt: state.timerEndsAt, remaining };
  updateTimerElements($("#timer-display"), $("#timer-progress"), $("#timer-status"));
  updateTimerElements($("#projector-timer"), $("#projector-progress"), $("#projector-timer-status"));
  const roundSelect = $("#round-select");
  if (roundSelect) roundSelect.value = String(state.roundNumber);
  const questionDurationInput = $("#question-duration");
  if (questionDurationInput && document.activeElement !== questionDurationInput) {
    questionDurationInput.value = String(state.questionTimerDuration);
  }
  const timerTypeLabel = state.timerMode === "bonus" ? "BONUS ANSWER · 10 SECONDS" : "QUESTION TIMER";
  const adminTimerLabel = $("#admin-timer-label");
  if (adminTimerLabel) adminTimerLabel.textContent = timerTypeLabel;
  const projectorTimerLabel = $("#projector-timer-label");
  if (projectorTimerLabel) projectorTimerLabel.textContent = timerTypeLabel;
  const roundLabel = `ROUND ${state.roundNumber} OF 4`;
  if (page === "projector" && lastRenderedRound !== null && lastRenderedRound !== state.roundNumber) {
    announceRound(state.roundNumber);
  }
  lastRenderedRound = state.roundNumber;
  const adminRound = $("#admin-round-label");
  if (adminRound) adminRound.textContent = roundLabel;
  const projectorRound = $("#projector-round-label");
  if (projectorRound) projectorRound.textContent = roundLabel;
  const projectorRoundNumber = $("#projector-round-number");
  if (projectorRoundNumber) projectorRoundNumber.textContent = String(state.roundNumber);
}

function renderSpotlight() {
  const projectorSpotlight = $("#projector-spotlight");
  if (!projectorSpotlight) return;
  const isVisible = state.spotlightTeamId !== null && state.spotlightEndsAt > Date.now();
  const selectedTeam = state.teams.find((team) => team.id === state.spotlightTeamId);
  projectorSpotlight.classList.toggle("hidden", !isVisible || !selectedTeam);
  if (selectedTeam) $("#projector-spotlight-name").textContent = selectedTeam.name;
}

function renderProjectorQr() {
  const projectorQr = $("#projector-qr-dialog");
  const isVisible = state.projectorQrVisible;
  const toggle = $("#projector-qr-toggle");
  if (toggle) {
    toggle.textContent = isVisible ? "Hide projector QR" : "Show projector QR";
    toggle.setAttribute("aria-pressed", String(isVisible));
  }
  if (!projectorQr) return;
  projectorQr.classList.toggle("hidden", !isVisible);
  projectorQr.setAttribute("aria-hidden", String(!isVisible));
}

function renderWinner() {
  const teamSelect = $("#winner-team-select");
  if (teamSelect) {
    const selectedTeamId = state.winnerTeamId ?? "";
    teamSelect.innerHTML = `<option value="">Choose a team to announce</option>${state.teams
      .map((team) => `<option value="${escapeHtml(team.id)}">${escapeHtml(team.name)}</option>`)
      .join("")}`;
    teamSelect.value = selectedTeamId;
    teamSelect.disabled = !hasLoadedState || !socket?.connected || state.winnerVisible;
  }

  const openButton = $("#winner-open");
  if (openButton) {
    openButton.disabled = !hasLoadedState || !socket?.connected || state.winnerTeamId === null || state.winnerVisible;
  }
  const closeButton = $("#winner-close");
  if (closeButton) {
    closeButton.classList.toggle("hidden", !state.winnerVisible);
    closeButton.disabled = !hasLoadedState || !socket?.connected;
  }

  const modal = $("#projector-winner-overlay");
  if (!modal) return;
  const isVisible = page === "projector" && state.winnerVisible;
  const team = state.teams.find((item) => item.id === state.winnerTeamId);
  modal.classList.toggle("hidden", !isVisible);
  modal.setAttribute("aria-hidden", String(!isVisible));
  if (team && isVisible) {
    modal.style.setProperty("--team-color", team.color);
    $("#projector-winner-name").textContent = team.name;
    $("#projector-winner-score").textContent = String(team.score);
    $("#projector-winner-mark").innerHTML =
      teamLogoMarkup(team, "winner-team-logo") || `<span>${escapeHtml(team.name.trim().charAt(0).toUpperCase())}</span>`;
    if (!lastWinnerVisible || team.id !== lastWinnerTeamId) {
      launchIntroConfetti("#winner-confetti");
      playApplause();
    }
  }
  lastWinnerVisible = isVisible;
  lastWinnerTeamId = team?.id ?? null;
}

function sortedTeams() {
  return state.teams.map((team, index) => ({ ...team, originalIndex: index }))
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex);
}

function renderTeams() {
  const teamCount = $("#team-count");
  if (teamCount) teamCount.textContent = String(state.teams.length);
  const teamList = $("#team-list");
  if (teamList) {
    teamList.innerHTML = state.teams.map((team, index) => `
      <article class="team-card" style="--team-color: ${team.color}; animation-delay: ${Math.min(index, 6) * 45}ms">
        <span class="team-avatar" aria-hidden="true">${teamLogoMarkup(team, "team-logo")}<span class="${team.logo ? "hidden" : ""}">${escapeHtml(team.name.trim().charAt(0).toUpperCase())}</span></span>
        <span class="team-info"><strong>${escapeHtml(team.name)}</strong><span>TEAM ${String(index + 1).padStart(2, "0")}</span></span>
        <span class="team-status" aria-hidden="true"></span>
      </article>
    `).join("");
  }

  const projectorCount = $("#projector-team-count");
  if (projectorCount) projectorCount.textContent = String(state.teams.length);
  renderSpotlight();
  renderScores();
  renderTeamIntro();
  renderWinner();
}

function teamLogoMarkup(team, className) {
  return team.logo ? `<img class="${className}" src="${escapeHtml(team.logo)}" alt="" />` : "";
}

function renderScores() {
  const canEditScores = hasLoadedState && Boolean(socket?.connected);
  ["#question-points", "#bonus-points", "#clear-scores"]
    .forEach((selector) => {
      const control = $(selector);
      if (control) control.disabled = !canEditScores;
    });
  if (lastScoreRound !== null && lastScoreRound !== state.roundNumber) {
    ["#question-points", "#bonus-points"].forEach((selector) => {
      const input = $(selector);
      if (input) input.value = input.defaultValue;
    });
  }
  lastScoreRound = state.roundNumber;
  const scoreRoundLabel = $("#score-round-label");
  if (scoreRoundLabel) scoreRoundLabel.textContent = `ROUND ${state.roundNumber} OF 4`;
  const scoreRoundHeading = $("#score-round-heading");
  if (scoreRoundHeading) scoreRoundHeading.textContent = `ROUND ${state.roundNumber}`;
  const scoreList = $("#score-list");
  if (scoreList) {
    scoreList.innerHTML = sortedTeams().map((team, index) => `
      <tr class="score-row" style="--team-color: ${team.color}; animation-delay: ${index * 35}ms">
        <td><span class="rank-number ${index === 0 && state.teams.length ? "is-first" : ""}">${String(index + 1).padStart(2, "0")}</span></td>
        <td><span class="score-team-cell">${teamLogoMarkup(team, "score-team-logo") || `<span class="score-dot"></span>`}<span class="score-team-name">${escapeHtml(team.name)}</span></span></td>
        <td><span class="score-round-points">${team.roundScores[state.roundNumber - 1]}</span></td>
        <td><span class="score-points">${team.score}</span></td>
        <td><span class="score-actions">
          <button class="score-award-button" type="button" data-award="${escapeHtml(team.id)}" data-award-type="question" ${canEditScores ? "" : "disabled"}>Question</button>
          <button class="score-award-button is-bonus" type="button" data-award="${escapeHtml(team.id)}" data-award-type="bonus" ${canEditScores ? "" : "disabled"}>Bonus</button>
        </span></td>
      </tr>
    `).join("");
    const emptyState = $("#empty-state");
    if (emptyState) emptyState.classList.toggle("hidden", state.teams.length !== 0);
    const summary = $("#score-summary");
    if (summary) summary.textContent = `${state.teams.length} ${state.teams.length === 1 ? "team" : "teams"} playing`;
  }

  const projectorScores = $("#projector-score-list");
  if (projectorScores) {
    projectorScores.innerHTML = sortedTeams().map((team, index) => `
      <li class="projector-score-row" style="--team-color: ${team.color}; animation-delay: ${index * 50}ms">
        <span class="projector-rank ${index === 0 && state.teams.length ? "is-first" : ""}">${String(index + 1).padStart(2, "0")}</span>
        ${teamLogoMarkup(team, "projector-team-logo") || `<span class="projector-score-dot"></span>`}<span class="projector-score-name">${escapeHtml(team.name)}</span>
        <strong>${team.score}</strong>
      </li>
    `).join("");
    const emptyState = $("#projector-empty");
    if (emptyState) emptyState.classList.toggle("hidden", state.teams.length !== 0);
  }
}

function renderTeamIntro() {
  const teamIndex = Math.min(state.teamIntroIndex, Math.max(state.teams.length - 1, 0));
  const adminNavigation = $("#team-intro-admin-navigation");
  if (adminNavigation) adminNavigation.classList.toggle("hidden", !state.teamIntroVisible);
  const openButton = $("#team-intro-open");
  if (openButton) openButton.disabled = !hasLoadedState || !socket?.connected || state.teamIntroVisible;
  const previousButton = $("#team-intro-previous");
  if (previousButton) previousButton.disabled = !hasLoadedState || !socket?.connected || teamIndex === 0;
  const nextButton = $("#team-intro-next");
  if (nextButton) nextButton.disabled = !hasLoadedState || !socket?.connected || teamIndex >= state.teams.length - 1;
  const closeButton = $("#team-intro-close");
  if (closeButton) closeButton.disabled = !hasLoadedState || !socket?.connected;
  const position = $("#team-intro-admin-position");
  if (position) position.textContent = `TEAM ${teamIndex + 1} OF ${state.teams.length}`;
  const hint = $("#team-intro-admin-hint");
  if (hint) hint.classList.toggle("hidden", state.teamIntroVisible);

  const modal = $("#projector-team-intro");
  if (!modal) return;
  const isVisible = page === "projector" && state.teamIntroVisible;
  const team = state.teams[teamIndex];
  modal.classList.toggle("hidden", !isVisible);
  modal.setAttribute("aria-hidden", String(!isVisible));

  const count = $("#projector-intro-team-count");
  if (count) count.textContent = `${state.teams.length} ${state.teams.length === 1 ? "TEAM" : "TEAMS"}`;
  const progress = $("#projector-intro-progress");
  if (progress) {
    progress.innerHTML = state.teams.map((_, index) =>
      `<span class="intro-progress-segment ${index < teamIndex ? "is-done" : ""} ${index === teamIndex ? "is-current" : ""}"></span>`,
    ).join("");
  }

  const isNewIntroduction = isVisible && (!lastIntroVisible || teamIndex !== lastIntroIndex);
  if (team && isVisible) {
    const card = $("#projector-intro-team-card");
    card.style.setProperty("--team-color", team.color);
    $("#projector-intro-team-number").textContent = `TEAM ${String(teamIndex + 1).padStart(2, "0")} / ${String(state.teams.length).padStart(2, "0")}`;
    $("#projector-intro-team-avatar").innerHTML =
      teamLogoMarkup(team, "intro-team-logo") || `<span>${escapeHtml(team.name.trim().charAt(0).toUpperCase())}</span>`;
    $("#projector-intro-team-name").textContent = team.name;
    if (isNewIntroduction) {
      card.classList.remove("is-entering");
      void card.offsetWidth;
      card.classList.add("is-entering");
      playApplause();
      launchIntroConfetti();
    }
  }
  lastIntroVisible = isVisible;
  lastIntroIndex = teamIndex;
}

function render() {
  renderTimer();
  renderTeams();
  renderProjectorQr();
}

function updateState(updater) {
  const nextState = {
    ...state,
    teams: state.teams.map((team) => ({ ...team })),
  };
  updater(nextState);
  setState(nextState);
}

function bindAdminControls() {
  const timerToggle = $("#timer-toggle");
  if (timerToggle) {
    timerToggle.addEventListener("click", () => {
      const remaining = remainingSeconds();
      if (state.timerEndsAt === null || remaining === 0) enableTimerSound();
      updateState((nextState) => {
        if (nextState.timerEndsAt !== null && remaining > 0) {
          nextState.timerRemaining = remaining;
          nextState.timerEndsAt = null;
        } else {
          const duration = remaining > 0 ? remaining : nextState.timerDuration;
          nextState.timerRemaining = duration;
          nextState.timerEndsAt = Date.now() + duration * 1000;
        }
      });
    });
    $("#timer-reset").addEventListener("click", () => updateState((nextState) => {
      nextState.timerMode = "question";
      nextState.timerDuration = nextState.questionTimerDuration;
      nextState.timerRemaining = nextState.questionTimerDuration;
      nextState.timerEndsAt = null;
    }));
    $("#question-duration").addEventListener("change", (event) => {
      const duration = Number(event.target.value);
      if (!Number.isInteger(duration) || duration < 30 || duration > 60) {
        event.target.value = String(state.questionTimerDuration);
        showToast("Choose a question time between 30 and 60 seconds.");
        return;
      }
      updateState((nextState) => {
        nextState.timerMode = "question";
        nextState.questionTimerDuration = duration;
        nextState.timerDuration = duration;
        nextState.timerRemaining = duration;
        nextState.timerEndsAt = null;
      });
    });
    $("#bonus-timer").addEventListener("click", () => updateState((nextState) => {
      nextState.timerMode = "bonus";
      nextState.timerDuration = 10;
      nextState.timerRemaining = 10;
      nextState.timerEndsAt = Date.now() + 10_000;
    }));
    $("#round-select").addEventListener("change", (event) => {
      const roundNumber = Number(event.target.value);
      if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > 4) {
        event.target.value = String(state.roundNumber);
        showToast("Choose a valid round from 1 to 4.");
        return;
      }
      updateState((nextState) => {
        nextState.roundNumber = roundNumber;
        if (roundNumber !== state.roundNumber) {
          nextState.timerMode = "question";
          nextState.timerDuration = nextState.questionTimerDuration;
          nextState.timerRemaining = nextState.questionTimerDuration;
          nextState.timerEndsAt = null;
        }
      });
    });
  }

  const reset = $("#reset-event");
  if (reset) reset.addEventListener("click", () => {
    setState({
      ...initialState,
      teams: initialState.teams.map((team) => ({ ...team, score: 0 })),
    });
    showToast("The event is reset and ready to go.");
  });

  const projectorQrToggle = $("#projector-qr-toggle");
  if (projectorQrToggle) projectorQrToggle.addEventListener("click", () => {
    updateState((nextState) => {
      nextState.projectorQrVisible = !nextState.projectorQrVisible;
      if (nextState.projectorQrVisible) {
        nextState.teamIntroVisible = false;
        nextState.winnerVisible = false;
      }
    });
    showToast(state.projectorQrVisible ? "Projector QR is now on screen." : "Projector QR hidden.");
  });

  const teamIntroOpen = $("#team-intro-open");
  if (teamIntroOpen) teamIntroOpen.addEventListener("click", () => updateState((nextState) => {
    nextState.teamIntroVisible = true;
    nextState.teamIntroIndex = 0;
    nextState.projectorQrVisible = false;
    nextState.winnerVisible = false;
  }));
  const teamIntroPrevious = $("#team-intro-previous");
  if (teamIntroPrevious) teamIntroPrevious.addEventListener("click", () => updateState((nextState) => {
    nextState.teamIntroIndex = Math.max(0, nextState.teamIntroIndex - 1);
  }));
  const teamIntroNext = $("#team-intro-next");
  if (teamIntroNext) teamIntroNext.addEventListener("click", () => updateState((nextState) => {
    nextState.teamIntroIndex = Math.min(nextState.teams.length - 1, nextState.teamIntroIndex + 1);
  }));
  const teamIntroClose = $("#team-intro-close");
  if (teamIntroClose) teamIntroClose.addEventListener("click", () => updateState((nextState) => {
    nextState.teamIntroVisible = false;
  }));

  const winnerTeamSelect = $("#winner-team-select");
  if (winnerTeamSelect) winnerTeamSelect.addEventListener("change", (event) => {
    updateState((nextState) => {
      nextState.winnerTeamId = event.target.value || null;
    });
  });
  const winnerOpen = $("#winner-open");
  if (winnerOpen) winnerOpen.addEventListener("click", () => {
    if (!state.winnerTeamId) {
      showToast("Choose a winning team first.");
      return;
    }
    updateState((nextState) => {
      nextState.winnerVisible = true;
      nextState.teamIntroVisible = false;
      nextState.projectorQrVisible = false;
    });
  });
  const winnerClose = $("#winner-close");
  if (winnerClose) winnerClose.addEventListener("click", () => updateState((nextState) => {
    nextState.winnerVisible = false;
  }));
}

function bindScoreControls() {
  const scoreList = $("#score-list");
  if (scoreList) scoreList.addEventListener("click", (event) => {
    const awardButton = event.target.closest("[data-award]");
    if (awardButton) {
      if (!hasLoadedState || !socket?.connected) {
        showToast("Wait for the LIVE connection before awarding points.");
        return;
      }
      const inputSelector = awardButton.dataset.awardType === "bonus" ? "#bonus-points" : "#question-points";
      const pointsInput = $(inputSelector);
      const points = pointsInput.valueAsNumber;
      if (!pointsInput.checkValidity() || !Number.isSafeInteger(points) || points < 1 || points > 1_000_000) {
        pointsInput.focus();
        pointsInput.reportValidity();
        showToast("Enter a whole point value between 1 and 1,000,000.");
        return;
      }
      const team = state.teams.find((item) => item.id === awardButton.dataset.award);
      const roundIndex = state.roundNumber - 1;
      if (!team || !Number.isSafeInteger(team.score + points) ||
          !Number.isSafeInteger(team.roundScores[roundIndex] + points)) {
        showToast("That award would exceed the maximum supported score.");
        return;
      }
      updateState((nextState) => {
        const team = nextState.teams.find((item) => item.id === awardButton.dataset.award);
        if (team) {
          team.score += points;
          team.roundScores[roundIndex] += points;
        }
      });
      if (team) showToast(`${points} ${points === 1 ? "point" : "points"} awarded to ${team.name} for ${awardButton.dataset.awardType === "bonus" ? "a bonus answer" : "the question"}.`);
      return;
    }
  });

  const clearScores = $("#clear-scores");
  if (clearScores) clearScores.addEventListener("click", () => {
    if (!hasLoadedState || !socket?.connected) {
      showToast("Wait for the LIVE connection before clearing scores.");
      return;
    }
    if (state.teams.length === 0) return;
    updateState((nextState) => {
      nextState.teams.forEach((team) => {
        team.score = 0;
        team.roundScores = [0, 0, 0, 0];
      });
    });
    showToast("All scores are back to zero.");
  });
}

function bindSpotlight() {
  const button = $("#shuffle-teams");
  if (!button) return;
  button.addEventListener("click", () => {
    if (!state.teams.length) {
      showToast("Add a team before choosing who is up next.");
      return;
    }
    const team = state.teams[Math.floor(Math.random() * state.teams.length)];
    updateState((nextState) => {
      nextState.spotlightTeamId = team.id;
      nextState.spotlightEndsAt = Date.now() + 3500;
    });
  });
}

function bindTeamIntroductions() {
  const applauseToggle = $("#intro-applause-toggle");
  if (applauseToggle) applauseToggle.addEventListener("click", enableApplause);
}

function bindProjectorSound() {
  const soundToggle = $("#timer-sound-toggle");
  if (soundToggle) soundToggle.addEventListener("click", enableTimerSound);
}

const fullscreenButton = $("#fullscreen-toggle");
if (fullscreenButton) fullscreenButton.addEventListener("click", async () => {
  enableTimerSound();
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (error) {
    console.error("Could not change fullscreen mode:", error);
    showToast("Fullscreen is unavailable in this browser.");
  }
});

document.addEventListener("fullscreenchange", () => {
  if (!fullscreenButton) return;
  const isFullscreen = Boolean(document.fullscreenElement);
  fullscreenButton.setAttribute("aria-label", isFullscreen ? "Exit fullscreen" : "Enter fullscreen");
  fullscreenButton.title = isFullscreen ? "Exit fullscreen" : "Enter fullscreen";
});

async function initialize() {
  try {
    await loadContent();
  } catch (error) {
    console.error("Could not initialize quiz content:", error);
    announceSync("CONTENT ERROR");
    showToast("Couldn't load quiz content. Check data/quiz-content.json.");
    return;
  }
  bindAdminControls();
  bindScoreControls();
  bindSpotlight();
  bindTeamIntroductions();
  bindProjectorSound();
  connectToGame();
  window.setInterval(renderTimer, 200);
  window.setInterval(renderSpotlight, 500);
}

void initialize();
window.addEventListener("beforeunload", () => {
  if (confettiAnimationFrame !== null) cancelAnimationFrame(confettiAnimationFrame);
});
