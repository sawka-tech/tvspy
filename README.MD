# tvspy

A small dashboard for a [TVHeadend](https://tvheadend.org) server: who is watching right now, which tuners are
in use and how well they receive, the full viewing history, and Telegram alerts when something needs attention.

This is a rework (v4) of [alebupal/tvspy](https://github.com/alebupal/tvspy). It runs as a single container: one
Node.js process serves the API and the web app and keeps its data in SQLite.

## What it shows

- **Live:** every stream and recording with channel, multiplex, tuner, viewer, app and device, connection (home
  network, internet address, or through an HTTPS proxy) and data rate. Below that, each tuner with its
  signal-to-noise ratio over the last 15 minutes.
- **History:** every session, filterable by period, viewer, channel, app and result. Channel changes within a minute
  count as one visit.
- **Alerts:** Telegram messages for TVHeadend being unreachable or rejecting tvspy's login, a multiplex without
  reception for 27 hours, and optionally viewing and recording start/stop and long viewing. Each event is sent at
  most once, also across restarts. Every alert is listed in the app, including those that were not sent.
- **Collected for later:** usage per hour, peak concurrency per day, and reception statistics per minute (kept
  90 days) and per hour (kept forever).

## Install

The image is `ghcr.io/sawka-tech/tvspy`. Tags: `latest` (main branch), `v4` (development branch), and an immutable
`sha-<commit>` per build. Pin a `sha-` tag for production so updates happen only when you choose.

```yaml
services:
  tvspy:
    image: ghcr.io/sawka-tech/tvspy:latest
    container_name: tvspy
    restart: unless-stopped
    ports:
      - 8183:80
    volumes:
      - ./data:/app/backend/src/database/file
    environment:
      - TZ=Europe/Warsaw
```

| Variable | Default | Meaning |
|---|---|---|
| `TZ` | `Europe/Warsaw` | Time zone for days, hours and times shown in the app |
| `TVSPY_TELEGRAM` | on | `off` stops all Telegram sending (test containers) |
| `LOG_LEVEL` | from settings | `debug`, `info`, `warn` or `error` |
| `TVSPY_SQLITE_JOURNAL` | `wal` | `delete` if the data directory is on a file system without WAL support |
| `PORT` | `80` | Port inside the container |

### First start

1. Open the app from your home network, by IP address (for example `http://192.168.1.10:8183`). No login is
   needed there.
2. In **Settings → TVHeadend**, enter its address (for example `http://192.168.1.10:9981`) and an account with
   **admin rights**. tvspy reads TVHeadend's status pages, which require admin. **Test connection** shows the version,
   the tuners and the number of channels it found.
3. In **Settings → Telegram**, optionally add a bot token (from @BotFather) and your chat ID, then send a test
   message.

### Access

- **Without a login:** tvspy opens from the networks in **Settings → Access**. The defaults are `192.168.0.0/16`
  (home networks) and `10.0.0.0/8` (typical VPNs).
- **Docker range left out:** `172.16.0.0/12` is not in the defaults on purpose. A reverse proxy container (for
  example Nginx Proxy Manager) connects from there and must not get around the login.
- **Other networks:** tvspy refuses them unless you set a password under Settings → Access. With a password, it
  asks for it.
- **Host names:** open it by IP address. A host name such as `tower.local` gets in without a login only after you
  list it under Settings → Access. This stops malicious websites that point their own name at your server (DNS
  rebinding).
- **Forgotten password:** run `docker exec -it tvspy node dist/cli.js set-password`.

Do not enable TVHeadend's "use X-Forwarded-For" proxy option. With it, any client can fake its address. Clients
coming through an HTTPS proxy show up as "HTTPS proxy" instead of with an address.

### Upgrading from tvspy 3.x

Keep the same data directory. On the first start, tvspy 4 imports the old `database.db` **read-only**; the file is
never changed. The import:

- **Keeps** viewing sessions and recordings.
- **Skips** TVHeadend's internal guide updates and scans.
- **Re-estimates** session lengths the old version recorded wrongly, using the data volume. These lengths are
  marked "≈" in the history.
- **Carries over** the TVHeadend and Telegram settings.

The import report is printed in the log. To roll back, start the previous image again; it still finds its
untouched `database.db`.

To preview the import without changing anything:

```bash
docker run --rm -v /path/to/data:/legacy:ro ghcr.io/sawka-tech/tvspy:latest \
  node dist/cli.js import-legacy --dry-run --repair --legacy /legacy/database.db
```

## Data and maintenance

The data directory holds:

- `tvspy.db`
- `backups/`: a copy every night at 03:30, the last 7 kept, plus a copy before each database upgrade.
- `cache/logos/`

Backups contain the TVHeadend password and the Telegram token, like the database itself.

Commands, run inside the container:

```bash
docker exec -it tvspy node dist/cli.js set-password   # set or reset the password for other networks
docker exec tvspy node dist/cli.js backup             # an extra backup now
```

## Development

Requires Node.js 24 (`nvm use`). The repository is an npm workspace: `tvspy-backend`, `tvspy-frontend` and
`shared` (the API types both use).

```bash
npm ci
npm test && npm run typecheck && npm run lint

# A fake TVHeadend with viewers and tuners (login spy / secret-pass):
cd tvspy-backend && npx tsx scripts/fake-tvh.ts --scenario evening
# The backend on 127.0.0.1:8080, Telegram off:
TVSPY_DATA_DIR=./.data TVSPY_HOST=127.0.0.1 PORT=8080 TVSPY_TELEGRAM=off npm run dev
# The frontend with hot reload on http://localhost:5173 (proxies /api to the backend):
cd tvspy-frontend && npm run dev
```

Point the app at `http://127.0.0.1:19981` to use the fake TVHeadend.
