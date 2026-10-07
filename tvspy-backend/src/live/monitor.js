// Keeps track of TVHeadend subscriptions by polling /api/status/subscriptions.
// Replaces the old one-shot WebSocket, which never reconnected after a TVHeadend restart
// and keyed sessions by start second (sessions starting in the same second collided).
const axios = require('axios');
const db = require('../database/database');
const { tvhGet, describeError } = require('../tvheadend/client');
const { getConfigValues } = require('../routes/configTvheadend');

const POLL_INTERVAL_MS = Math.max(1000, parseInt(process.env.POLL_INTERVAL_MS || '3000', 10));

const state = {
    connected: false,
    lastUpdate: null,
    lastError: 'Waiting for the first poll',
    subscriptions: [],
};
const lastSeen = new Map(); // session key -> last time (ms) it was seen in a poll
let debugLog = () => {};

const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); });
});
const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
});
const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
});

// TVHeadend's subscription id restarts after every TVHeadend restart; together with the start time it is unique.
const sessionKey = (sub) => `${sub.start}-${sub.id}`;

// Internal subscriptions (EPG grabber, mux scans, service mapper) have no client hostname.
// Recordings have no hostname either but are titled "DVR: ...".
const isClientOrRecording = (sub) => Boolean(sub.hostname) || String(sub.title || '').startsWith('DVR:');

const isRecording = (title) => Boolean(title) && title.includes('DVR:');

async function poll() {
    let entries;
    try {
        const data = await tvhGet('/api/status/subscriptions');
        entries = (data && Array.isArray(data.entries)) ? data.entries : [];
    } catch (err) {
        const reason = describeError(err);
        if (state.connected || state.lastError !== reason) console.error(`TVHeadend - ${reason}`);
        state.connected = false;
        state.lastError = reason;
        // Keep open sessions as they are; they are settled once TVHeadend answers again.
        return;
    }

    if (!state.connected) console.log('TVHeadend - connected, monitoring subscriptions');
    state.connected = true;
    state.lastError = null;
    state.lastUpdate = new Date().toISOString();

    const now = Date.now();
    const current = entries.filter(isClientOrRecording);
    state.subscriptions = current;

    const config = await getConfigValues();
    const currentKeys = new Set(current.map(sessionKey));
    for (const sub of current) {
        lastSeen.set(sessionKey(sub), now);
        const playbackTime = Math.floor(now / 1000) - sub.start;
        if (playbackTime > Number(config.minimum_time || 0)) {
            await recordSession(sub, config);
        }
    }
    await closeEndedSessions(currentKeys, config);
    for (const key of [...lastSeen.keys()]) {
        if (!currentKeys.has(key)) lastSeen.delete(key);
    }
}

async function recordSession(sub, config) {
    const {
        start,
        errors = 0,
        hostname = '',
        client = '',
        channel = '',
        service = '',
        total_in = 0,
        username = 'No user',
        title = '',
    } = sub;
    const key = sessionKey(sub);
    const row = await get(
        'SELECT id, start, notification_time, notification_ip, hostname, username, channel, client FROM registries WHERE sub_key = ?',
        [key]
    );

    if (!row) {
        await run(`
            INSERT INTO registries (sub_key, username, channel, hostname, client, service, errors, total_in, start, end, title, notification_time, notification_ip)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [key, username, channel, hostname, client, service, errors, total_in, unixToISO(start), null, title, false, false]);
        debugLog('Session recorded:', key);

        const replacements = { username, channel, date: formatISODate(unixToISO(start)), client, hostname };
        if (isRecording(title)) {
            notify(config, 'telegram_notification_start_recording', 'telegram_notification_start_recording_text', replacements);
        } else {
            notify(config, 'telegram_notification_start_playback', 'telegram_notification_start_playback_text', replacements);
        }
        return;
    }

    const replacements = {
        username: row.username,
        channel: row.channel,
        date: formatISODate(row.start),
        client: row.client,
        hostname: row.hostname,
    };

    // Watching longer than the configured limit (minutes): notify once per session.
    const minutes = Math.floor((Date.now() - new Date(row.start).getTime()) / 60000);
    if (config.telegram_notification === '1' && config.telegram_notification_time === '1' &&
        minutes > parseInt(config.telegram_time_limit, 10) && !row.notification_time) {
        sendTelegramMessage(formatMessage(config.telegram_notification_time_text, replacements), config);
        await run('UPDATE registries SET notification_time = ? WHERE id = ?', [true, row.id]);
    }

    // Client IP not in the allowed list: notify once per session.
    const allowedIPs = config.ip_allowed ? config.ip_allowed.split(',').map((ip) => ip.trim()) : [];
    if (config.telegram_notification === '1' && config.telegram_notification_ip_not_allowed === '1' &&
        !allowedIPs.includes(row.hostname) && !row.notification_ip) {
        sendTelegramMessage(formatMessage(config.telegram_notification_ip_not_allowed_text, replacements), config);
        await run('UPDATE registries SET notification_ip = ? WHERE id = ?', [true, row.id]);
    }

    await run('UPDATE registries SET errors = ?, total_in = ? WHERE id = ?', [errors, total_in, row.id]);
}

async function closeEndedSessions(currentKeys, config) {
    const open = await all(
        'SELECT id, sub_key, title, username, channel, start, client, hostname FROM registries WHERE end IS NULL AND sub_key IS NOT NULL'
    );
    for (const row of open) {
        if (currentKeys.has(row.sub_key)) continue;

        // End at the last poll that still saw the session; if this process never saw it, now.
        const end = new Date(lastSeen.get(row.sub_key) || Date.now()).toISOString();
        await run('UPDATE registries SET end = ? WHERE id = ?', [end, row.id]);
        debugLog('Session ended:', row.sub_key);

        const replacements = {
            username: row.username,
            channel: row.channel,
            date: formatISODate(row.start),
            client: row.client,
            hostname: row.hostname,
        };
        if (isRecording(row.title)) {
            notify(config, 'telegram_notification_stop_recording', 'telegram_notification_stop_recording_text', replacements);
        } else {
            notify(config, 'telegram_notification_stop_playback', 'telegram_notification_stop_playback_text', replacements);
        }
    }
}

function notify(config, flag, textKey, replacements) {
    if (config.telegram_notification === '1' && config[flag] === '1') {
        sendTelegramMessage(formatMessage(config[textKey], replacements), config);
    }
}

function sendTelegramMessage(message, config) {
    axios.post(`https://api.telegram.org/bot${config.telegram_bot_token}/sendMessage`, {
        chat_id: config.telegram_id,
        text: message,
        parse_mode: 'HTML',
    }).catch((error) => console.error('Error sending Telegram message:', error.message));
}

function unixToISO(unixTimestamp) {
    return new Date(unixTimestamp * 1000).toISOString();
}

function formatMessage(template, values) {
    return (template || '')
        .replace('%%username%%', values.username || '')
        .replace('%%channel%%', values.channel || '')
        .replace('%%date%%', values.date || '')
        .replace('%%client%%', values.client || '')
        .replace('%%hostname%%', values.hostname || '');
}

function formatISODate(isoDateString) {
    const date = new Date(isoDateString);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function loop() {
    try {
        await poll();
    } catch (err) {
        console.error('Monitor - unexpected error:', err.message);
    }
    setTimeout(loop, POLL_INTERVAL_MS);
}

async function start() {
    await db.ready;
    const debug = await get('SELECT value FROM config WHERE name = ?', ['debug_mode']).catch(() => null);
    debugLog = debug && debug.value === '1' ? console.log : () => {};
    console.log(`Monitor - polling TVHeadend subscriptions every ${POLL_INTERVAL_MS / 1000}s`);
    loop();
}

function getState() {
    return { ...state };
}

module.exports = { start, getState };
