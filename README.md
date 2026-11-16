# Tavern Trivia

A turn-based trivia duel for iOS, Android and the web. Two players, six rounds, three questions per round. Players alternate picking the category and answer whenever it suits them.

"Tavern Trivia" is a placeholder name. Change it in `app/app.json` and `app/src/app/login.tsx`.

## Layout

| Folder | What it is |
| --- | --- |
| `app/` | The Expo (React Native) app. One codebase for iOS, Android and web. |
| `server/` | Node + Fastify + Postgres API. Holds all game rules, so the app cannot cheat. |
| `server/questions/` | The seed questions, one JSON file per category. |
| `Dockerfile` | Builds one image that serves the API and the web app together. |

## How a game works

1. A player starts a game against a random opponent or a named friend.
2. They pick one of three offered categories and answer three questions, 20 seconds each.
3. The opponent answers the same three questions, then picks the next category and plays it.
4. After six rounds the higher score wins. Winners gain rating (Elo) and everyone gains XP.
5. A player who does not move for 72 hours forfeits.

The server never sends the correct answer before the player has answered, hides the opponent's results for a round until you have played it, and enforces the timer itself.

## Run it locally

You need Node 22 and Postgres 14 or newer.

```bash
# 1. Database
createuser quiz --pwprompt        # password: quiz
createdb -O quiz quiz

# 2. Server (creates tables and loads the questions on first start)
cd server
npm install
ADMIN_TOKEN=local-admin-token npm run dev      # http://localhost:3000

# 3. App
cd ../app
npm install
cp .env.example .env
npx expo start        # press w for web, or scan the QR code with Expo Go
```

To test on a real phone, set `EXPO_PUBLIC_API_URL` in `app/.env` to your computer's LAN address, for example `http://192.168.1.20:3000`. A phone cannot reach `localhost`.

Server tests need a second database: `createdb -O quiz quiz_test`, then `npm test` in `server/`.

## Questions

Edit the files in `server/questions/` and run `npm run seed` in `server/`. The first answer in each `a` list is the correct one; the app shuffles them. Running the seed again updates existing questions and never duplicates them.

For day-to-day edits use the admin page at `/admin` on your server. It is only available when `ADMIN_TOKEN` is set, and asks for that token.

A category needs at least three active questions before it is offered. Aim for 100 or more per category so regular players do not see repeats.

## Deploy

The server needs three settings:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Postgres connection string from your host |
| `JWT_SECRET` | 32+ random characters, e.g. `openssl rand -hex 32`. Changing it signs everyone out. |
| `ADMIN_TOKEN` | 24+ random characters. Leave unset to disable `/admin`. |

Any host that runs a Dockerfile and offers managed Postgres works (Fly.io, Railway, Render). Point it at this repository; the image serves the API under `/api` and the web app at `/`. The server refuses to start in production without a proper `JWT_SECRET`.

Turn on database backups at your host.

## Publish the phone apps

1. Create an [Expo](https://expo.dev) account and install the CLI: `npm install -g eas-cli`.
2. In `app/app.json` add `ios.bundleIdentifier` and `android.package` (for example `com.yourname.taverntrivia`).
3. Set `EXPO_PUBLIC_API_URL` to your public `https://` server address for the build (`eas env:create` or `app/.env`).
4. `eas build --platform all`, then `eas submit`.

You need an Apple Developer account (99 USD per year) and a Google Play developer account (25 USD once). Both stores require a privacy policy. The app already has in-app account deletion, which both stores require.

## Not built yet

- Push notifications when it is your turn. The app currently refreshes while it is open.
- Password reset. Accounts have no email address, so a forgotten password cannot be recovered.
- Reporting or filtering of offensive usernames.
- Group games with more than two players.
