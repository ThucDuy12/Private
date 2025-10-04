const { parentPort } = require('worker_threads');
const axios = require('axios');

parentPort.on('message', async (msg) => {
  if (msg === 'update') {
    try {
      const res = await axios.get('https://data.vatsim.net/v3/vatsim-data.json', { timeout: 15000 });
      const data = res.data || {};
      const prefix = ['VV', 'VL', 'VD'];
      const controllers = (data.controllers || []).filter(c => prefix.includes(((c.callsign||'').slice(0,2) || '').toUpperCase()));
      const pilots = (data.pilots || []).filter(p => p.flight_plan && (prefix.includes(((p.flight_plan.departure||'').slice(0,2)||'').toUpperCase()) || prefix.includes(((p.flight_plan.arrival||'').slice(0,2)||'').toUpperCase())));
      parentPort.postMessage({ controllers, pilots });
    } catch (err) {
      parentPort.postMessage({ error: err.message || String(err) });
    }
  }
});