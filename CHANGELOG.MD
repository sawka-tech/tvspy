# Changelog TVSPY

## [4.0.0] - unreleased

A rewrite in TypeScript (backend: Hono and SQLite; frontend: React), shipped as one smaller container.

- Opens without login from your home network and VPN; optional password for other networks.
- Live view with logos, multiplex, tuner, app and device, connection type and data rate, plus each tuner's
  reception (signal-to-noise) over the last 15 minutes.
- History with server-side filters and paging; channel changes count as one visit.
- Telegram alerts for TVHeadend down or rejecting the login and for a multiplex without reception, besides
  the existing start/stop/long-viewing messages. Fixed texts; every event at most once.
- Reception, usage and concurrency statistics collected from the first day for the coming statistics pages.
- Read-only import of the 3.x database with repaired session lengths; the old file stays untouched.
- Nightly backups, a password reset command, and strict security headers. Secrets are never sent to the browser.
- English only.

## [3.0.4] - 2025-03-24

- Support for arm32/v7

## [3.0.3] - 2024-11-14

- Add debug mode

## [3.0.2] - 2024-11-11

- Updated dependencies to the latest versions, add TZ and LOCALE.

## [3.0.1] - 2024-08-26

- Updated dependencies to the latest versions for improved security and stability.

## [3.0.0] - 2024-08-26

- Backend: Migrated the backend to Node.js.
- Frontend: Rebuilt the frontend using React.js.
- Database: Implemented MySQL Lite.
- Connection: Integrated WebSocket for connection in TVHeadend.
- In spanish and english

## [2.0.3] - 2024-08-22

- Update workflows.

## [2.0.2] - 2019-01-03

- Added channel logos during import.
- Added logos on the home page.

## [2.0.1] - 2018-12-29

- Fixed issue where notifications did not appear when playback started.
- Added user selector to the "Playback Time by Channel (Minutes)" graph.

## [2.0.0] - 2018-12-05

- Database changes, previous versions are not compatible.
- Added color indicators in logs depending on whether the connection is allowed or not.
- Allowed IPs can now be added in the configuration.
- IP localization.
- Configuration restructuring.
- Menu restructuring.
- Updated base Bootstrap template.
- Added the ability to backup and restore the database.
- Compatibility with TvHeadend when set to English.
- Restructured Dockerfile for improved compatibility.
- Checks for new versions.
- Telegram notification when recording starts or stops.
- Logs when something is recorded, shown as "Recording:" in the player option.
- If the file /var/www/html/bd_backup/backup.sql exists, it is imported at startup.

## [1.2.4] - 2018-06-21

- The TVHeadend API repeats IDs, so from now on, playback is identified using the ID and the start time.
- Rounded time in the log table.
- Changed the title of the "Home" menu.
- The idReproduccion field in the database is now a varchar(200).

## [1.2.3] - 2018-06-01

- Fixed double notification issue.

## [1.2.2] - 2018-06-01

- Fixed issue with extra notification time.

## [1.2.1] - 2018-06-01

- Fixed issue where the date was not displayed in Telegram messages.

## [1.2.0] - 2018-06-01

- The time in the database is now stored in seconds.
- Added the ability to select the time unit to be used on the web.
- Added the option to set a minimum time for an entry to be recorded.

## [1.1.0] - 2018-05-31

- Added date filter in graphs.
- Prevent entries from being added to the database when TvHeadend is scanning.
- Fixed issue with starting MySQL and Apache services.

## [1.0.0] - 2018-05-25

- Initial release.
