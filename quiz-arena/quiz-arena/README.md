# QUIZ ARENA

A real-time multiplayer quiz game for 2–8 players. Players join a private six-character room code from separate phones, tablets, or computers.

## Features

- Create and join private rooms with six-character codes
- 2–8 players per match; host-only start control
- 15 randomly selected multiple-choice questions in English
- Mixed categories: geography, science, history, sports, technology, entertainment, general knowledge, and brain teasers
- Server-authoritative 15-second question clock
- One locked answer per player per question
- Correct answer: 100 base points plus a speed bonus (up to 50)
- Live player status, round results, final leaderboard, podium, and tie-break question
- Reconnection support using a per-player browser token
- Responsive layout for mobile and desktop
- No client-side dependencies or build step; Node.js built-ins only

## Run locally

Requirements: Node.js 20 or newer.

```bash
npm start
```

Open http://localhost:3000 in a browser. To test multiplayer, open a second browser profile/incognito window or use a second device on the same network. For a second device on the same Wi-Fi, open `http://YOUR_COMPUTER_LAN_IP:3000` (allow port 3000 through the computer firewall).

## Deploy to Render

1. Push this folder to a GitHub repository.
2. In Render, create **New → Web Service** and connect the repository.
3. Set **Root Directory** to `quiz-arena` if this folder is inside a larger repository; otherwise leave it blank.
4. Set **Build Command** to `npm install` (there are no external dependencies; `npm install` is safe) and **Start Command** to `npm start`.
5. Choose a Node runtime and create the service. Render supplies `PORT` automatically.
6. Open the assigned HTTPS URL on two separate devices and test a complete match.

The app uses server-sent events (SSE) for server-to-player live updates and HTTP POST requests for player actions. This is a real-time multiplayer architecture; it does not require Socket.IO. Keep the web service as a single instance because active rooms are held in process memory. Rooms expire after two hours of inactivity and are lost if the server restarts or redeploys. For production persistence and multi-instance scaling, move room state to Redis and store match history in PostgreSQL.

## API

- `GET /api/health` — service health
- `POST /api/rooms` — create a room (`{ "name": "Player" }`)
- `POST /api/rooms/join` — join (`{ "code": "ABC234", "name": "Player" }`)
- `GET /api/rooms/:code/state` — get current state (header `X-Player-Token`)
- `GET /api/rooms/:code/events?token=...` — live SSE stream
- `POST /api/rooms/:code/start` — host starts the match
- `POST /api/rooms/:code/answer` — submit `{ "answer": 0 }` through `{ "answer": 3 }`
- `POST /api/rooms/:code/leave` — leave waiting room / mark disconnected in active match

## Important implementation notes

- The server owns the timer and score calculation; browser clock display is cosmetic only.
- Correct answers are not sent to clients until the reveal phase.
- Player tokens are random bearer credentials. Do not share them.
- This first release is deployment-ready but not yet horizontally scalable or backed by durable storage.
