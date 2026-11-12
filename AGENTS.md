# AGENTS.md — Coding Agent Operating Manual

> Give this file to your coding agent and check that it is using these instructions. Keep the stack, commands, and ground rules current.

## 1. Project Overview
- **What this repo builds:** LinkWise, a personalized commuter assistant — “Smarter connections, every day.” It helps NJ→NYC commuters catch their transit connections (PATH, NJ Transit Rail, Hudson-Bergen Light Rail) through a large, colorful departure countdown. Build 1 is a local slice: save multi-leg commutes, get the right one suggested by day/time, and watch a live-style countdown to the next train. All departure data is clearly labeled MOCK.
- **Primary user & core workflow:** NJ-resident NYC commuters who ride the same routes daily. Core workflow: dashboard suggests (or user switches to) a saved commute → large per-second departure countdown shows boarding station, destination, direction, and operator → rider taps “I'm on this train → Next leg” to advance through legs → the countdown rolls to the next eligible departure when one passes. Commutes persist in `localStorage`. See the living PRD in `docs/index.html`.
- **Tech stack:** Static HTML/CSS/vanilla JS (no build step, no backend). The app lives in `docs/app/` so GitHub Pages (`main` → `/docs`) publishes it alongside the Product Page. Mock schedule data in `docs/app/data/mock_schedule.json`, read through a single `ScheduleService` seam in `docs/app/app.js` so a real transit API can replace it later. Deterministic logic tests in `tests/schedule_logic.test.js` (run with `node`).
- **Hard constraints:** No live transit APIs, no fabricated real-time information. All departure times are illustrative MOCK data and labeled as such. No fare payments, checkout baskets, or ticket wallets in the main experience.

## 2. Commands
- **Install dependencies:** none (static app).
- **Run locally:** `cd docs/app && python3 -m http.server 8000` then open `http://localhost:8000/` (serving via http is required so the browser can `fetch` the JSON).
- **Live URLs (GitHub Pages):** app at `https://building-with-ai-f26.github.io/ip2618-FareLink/app/`, Product Page at `https://building-with-ai-f26.github.io/ip2618-FareLink/`.
- **Run deterministic tests:** `node tests/schedule_logic.test.js` (pure logic — ScheduleService, countdown formatting, next-departure selection, weekday validity, day/time commute suggestion; no browser or network).
- **Run model evals:** none yet (no model in Build 1).

## 3. Non-Negotiable Engineering Rules
1. **Plan before coding:** Before touching multiple files, propose a brief plan and wait for approval.
2. **Small batches:** Make small, focused changes that can be reviewed and explained by a human in a single Pull Request.
3. **Explainability:** Avoid unnecessary abstractions or dependencies. Help the human builder understand the main components, what changed, why it matters, what could break, and how it was checked.
4. **Verify changes:** Run relevant checks. For a reproducible logic bug, use a failing test to demonstrate the fix when practical. Record manual checks and known limitations; follow the selected Build 4 evaluation track.
5. **Zero secrets in code:** Never hardcode API keys, tokens, or credentials. Always read from environment variables (`.env`) and update `.env.example` when new variables are needed.
6. **Stop when looping:** If a fix fails twice in a row, stop, summarize what failed, and ask the human before trying a third approach.
