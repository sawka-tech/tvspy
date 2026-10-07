const express = require('express');
const { getState } = require('../live/monitor');

const app = express.Router();

// Current TVHeadend subscriptions as last seen by the backend monitor, plus connection status.
// The browser no longer connects to TVHeadend itself, so it never needs the TVHeadend credentials.
app.get('/live', (req, res) => {
    res.json(getState());
});

module.exports = app;
