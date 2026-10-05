# PlanSurf Service

Shared API for PlanSurf's static HTML apps. The API runs as one Render web service, keeps the GitHub token server-side, and reads and writes each app's JSON file in the private `beawart/plansurf-data` repository.

## Apps and storage

| App key | Login route | Data route | Default private-repo file |
| --- | --- | --- | --- |
| `budget` | `/api/budget/login` | `/api/budget/data` | `plansurf.budget-data.json` |
| `dailyspark` | `/api/dailyspark/login` | `/api/dailyspark/data` | `plansurf.dailyspark-data.json` |
| `investment` | `/api/investment/login` | `/api/investment/data` | `plansurf.property-data.json` |

App routes are not hard-coded: use any lowercase app key containing letters, numbers, or hyphens (up to 40 characters), such as `travel`. Its default private-repo file is `plansurf.<app>-data.json`, so `travel` maps to `plansurf.travel-data.json`. No service code or redeploy is needed for a new key. Data routes accept and return JSON objects; Budget additionally validates its existing `plansurf-budget` format.

All apps use `APP_PASSWORD` by default, so anyone with that password can access every app. To isolate an app's access, optionally set `APP_PASSWORD_<APP_KEY>`; set `GITHUB_PATH_<APP_KEY>` only if you need a non-default filename. Replace hyphens in the app key with underscores for environment-variable suffixes; for example, `travel-notes` uses `APP_PASSWORD_TRAVEL_NOTES` and `GITHUB_PATH_TRAVEL_NOTES`. Overrides require a Render environment update and service restart/redeploy, but no code change.

The existing Budget frontend contract remains available: `POST /api/login`, `POST /api/logout`, and `GET`/`PUT /api/budget` continue to target Budget's file. Point its API base URL to the shared Render service; its login and sync request shapes do not need to change.

## Deploy on Render

Create a Blueprint from this repository using `render.yaml`, or create a Node web service with build command `npm install`, start command `npm start`, and health check path `/health`.

Set these secrets in Render's environment settings:

- `GITHUB_TOKEN`: fine-grained token with Contents read/write permission limited to `beawart/plansurf-data`.
- `SESSION_SECRET`: at least 32 random bytes.
- `APP_PASSWORD`: a long, unique password used by the app login/sync screens. This is the only app password required to add more apps.

The repository, branch, CORS origin, and optional per-app credentials/paths are configurable through `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`, `CORS_ORIGINS`, `APP_PASSWORD_<APP_KEY>`, and `GITHUB_PATH_<APP_KEY>`. Default data paths are distinct by app key. `CORS_ORIGINS` is a comma-separated list of exact origins, without URL paths. The GitHub Pages origin for all four listed app repositories is `https://beawart.github.io`, so another app under that origin needs no CORS change. Apps hosted on a different origin need that origin added to `CORS_ORIGINS` and the service restarted/redeployed.

Generate a session secret in PowerShell and paste it directly into Render:

```powershell
$bytes = New-Object byte[] 48
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
[Convert]::ToBase64String($bytes)
$rng.Dispose()
```

Do not commit secrets, put them in any frontend HTML, or grant the token access to unrelated repositories. Each frontend should send its configured password to its login route, keep the returned bearer token in memory, and include `Authorization: Bearer <token>` on data requests. Do not store the GitHub token or session token in the data repository.

## API contract

Login uses `POST /api/{app}/login` with `{"password":"..."}` and returns `{"token":"...","expiresIn":3600000}`. The app key must follow the lowercase slug format described above.

Read with `GET /api/{app}/data`; save the complete JSON object with `PUT /api/{app}/data`. A missing file reads as an empty object, except Budget initializes as `{"transactions":{},"goals":[]}`. For Budget, saves must include `{"app":"plansurf-budget","transactions":{},"goals":[]}` (with the app's actual transaction and goal data).

Logout with `POST /api/{app}/logout`. Health is available at `GET /health` and does not require authentication. JSON bodies are limited to 2 MiB; unauthenticated and cross-app requests are rejected.

## Local checks

Requires Node.js 20 or later. Configure the environment variables from `.env.example` in your shell, then run:

```sh
npm test
npm start
```

Check `http://localhost:3001/health`. Serve the HTML frontend over HTTP and include its exact origin in `CORS_ORIGINS`; `file://` origins are not supported.