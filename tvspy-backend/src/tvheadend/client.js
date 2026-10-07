const axios = require('axios');
const crypto = require('crypto');
const { getConfigValues } = require('../routes/configTvheadend');

const md5 = (data) => crypto.createHash('md5').update(data).digest('hex');

// Parse a WWW-Authenticate header ("Digest realm="x", nonce="y", qop="auth"") into scheme and params.
// When TVHeadend offers several schemes, Node joins them with ", "; the first scheme wins.
function parseChallenge(header) {
    if (!header) return null;
    const value = Array.isArray(header) ? header[0] : header;
    const [scheme, ...rest] = value.trim().split(/\s+/);
    const params = {};
    const re = /(\w+)=(?:"([^"]*)"|([^,\s]*))/g;
    let m;
    while ((m = re.exec(rest.join(' '))) !== null) {
        params[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
    }
    return { scheme: scheme.toLowerCase(), params };
}

function digestAuthorization(config, method, uri, p) {
    const cnonce = crypto.randomBytes(16).toString('hex');
    const nc = '00000001';
    const ha1 = md5(`${config.username}:${p.realm}:${config.password}`);
    const ha2 = md5(`${method}:${uri}`);
    const qop = p.qop ? p.qop.split(',').map((q) => q.trim()).find((q) => q === 'auth') : null;
    const response = qop
        ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
        : md5(`${ha1}:${p.nonce}:${ha2}`);

    let header = `Digest username="${config.username}", realm="${p.realm}", nonce="${p.nonce}", uri="${uri}", algorithm=MD5, response="${response}"`;
    if (qop) header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    if (p.opaque) header += `, opaque="${p.opaque}"`;
    return header;
}

// GET a TVHeadend endpoint (path + query) and return the response body.
// auth = "plain" sends Basic credentials up front; anything else follows the scheme TVHeadend asks for
// in its 401 challenge (Digest or Basic), so a server set to plain authentication also works.
async function tvhGet(endpoint, { timeout = 10000 } = {}) {
    const config = await getConfigValues();
    for (const key of ['protocol', 'hostname', 'port', 'username', 'password']) {
        if (!config[key]) {
            const err = new Error(`TVHeadend connection is not configured (missing ${key})`);
            err.code = 'NOT_CONFIGURED';
            throw err;
        }
    }

    const url = `${config.protocol}://${config.hostname}:${config.port}${endpoint}`;
    const basic = { username: config.username, password: config.password };

    if ((config.auth || '').trim() === 'plain') {
        return (await axios.get(url, { timeout, auth: basic })).data;
    }

    try {
        return (await axios.get(url, { timeout })).data;
    } catch (err) {
        if (!err.response || err.response.status !== 401) throw err;

        const challenge = parseChallenge(err.response.headers['www-authenticate']);
        if (challenge && challenge.scheme === 'digest' && challenge.params.nonce) {
            const headers = { Authorization: digestAuthorization(config, 'GET', endpoint, challenge.params) };
            return (await axios.get(url, { timeout, headers })).data;
        }
        return (await axios.get(url, { timeout, auth: basic })).data;
    }
}

// Short, human-readable reason for a failed TVHeadend request.
function describeError(err) {
    if (err.code === 'NOT_CONFIGURED') return err.message;
    if (err.response) {
        const status = err.response.status;
        if (status === 401) return 'TVHeadend rejected the login (HTTP 401): check username, password and authentication type';
        if (status === 403) return 'TVHeadend denied access (HTTP 403): the user needs admin rights to read subscriptions';
        return `TVHeadend answered HTTP ${status}`;
    }
    return `Cannot reach TVHeadend (${err.code || err.message})`;
}

module.exports = { tvhGet, describeError };
