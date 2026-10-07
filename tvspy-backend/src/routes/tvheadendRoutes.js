const express = require('express');
const app = express.Router();
const { tvhGet, describeError } = require('../tvheadend/client');

// Proxy a TVHeadend API call (Basic or Digest login handled by the client).
const getExternalData = async (endpoint, res) => {
    try {
        res.json(await tvhGet(endpoint));
    } catch (error) {
        const message = describeError(error);
        console.error(`TVHeadend - ${endpoint}: ${message}`);
        res.status(error.code === 'NOT_CONFIGURED' ? 404 : 500).json({ error: message });
    }
};

// Rutas
app.get('/channel', async (req, res) => {
    const { name } = req.query; // Obtén el parámetro 'name' de la consulta
    const limit = 1000000; // O cualquier otro valor que necesites

    // Construye la URL con el parámetro 'name' si está presente
    let url = `/api/channel/grid?limit=${limit}`;
    if (name) {
        url += `&filter=${encodeURIComponent(JSON.stringify([{
            "type": "string",
            "value": name,
            "field": "name"
        }]))}`;
    }

    // Obtén datos de la URL construida
    await getExternalData(url, res);
});

app.get('/subscriptions', async (req, res) => {
    await getExternalData('/api/status/subscriptions', res);
});

app.get('/users', async (req, res) => {
    await getExternalData('/api/access/entry/grid?limit=1000000', res);
});

module.exports = app;
