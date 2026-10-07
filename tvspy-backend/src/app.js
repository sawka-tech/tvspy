const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const {  db } = require('./database/database');

const configRoutes = require('./routes/configRoutes');
const registriesRoutes = require('./routes/registriesRoutes');
const statisticsRoutes = require('./routes/statisticsRoutes');
const tvheadendRoutes = require('./routes/tvheadendRoutes');
const liveRoutes = require('./routes/liveRoutes');
const monitor = require('./live/monitor');

const app = express();
const port = 3001;

// Configura CORS para permitir solicitudes desde el origen de tu frontend
app.use(cors()); //Permitir todas

app.use(bodyParser.json());

// Utiliza las rutas relacionadas con 'config'
app.use('/api', configRoutes);
app.use('/api', registriesRoutes);
app.use('/api', tvheadendRoutes);
app.use('/api', statisticsRoutes);
app.use('/api', liveRoutes);

// Iniciar el servidor
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

monitor.start();
