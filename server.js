// ═══════════════════════════════════════════════════════════════
// JAN SAARTHI — Production Backend
// Stack: Node.js + Express + WebSocket + PostgreSQL (PostGIS)
// Run: npm install express ws pg cors uuid dotenv
//      node server.js
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const express  = require('express');
const { WebSocketServer } = require('ws');
const { Pool }  = require('pg');
const cors     = require('cors');
const { v4: uuid } = require('uuid');
const http     = require('http');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serve jan-saarthi.html from /public

// ── PostgreSQL (with PostGIS for geo queries) ──────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://postgres:password@localhost:5432/jansaarthi'
});

// ── DB SETUP ─────────────────────────────────────────────────
async function setupDB() {
  await db.query(`CREATE EXTENSION IF NOT EXISTS postgis`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS drivers (
      id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name      TEXT NOT NULL,
      type      TEXT NOT NULL,           -- bus | auto | erick | bike
      route_to  TEXT,
      seats     INT DEFAULT 3,
      fare      INT DEFAULT 15,
      online    BOOLEAN DEFAULT false,
      location  GEOGRAPHY(POINT, 4326),  -- PostGIS point
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id           TEXT PRIMARY KEY,
      driver_id    UUID REFERENCES drivers(id),
      rider_name   TEXT,
      rider_phone  TEXT,
      route        TEXT,
      fare         INT,
      payment      TEXT DEFAULT 'cash',
      status       TEXT DEFAULT 'confirmed', -- confirmed|boarding|completed|cancelled
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log('✅ Database ready');
}

// ── WEBSOCKET — Real-time location broadcasts ─────────────────
//
// Message types (JSON):
//   driver → server: { type:'location', driverId, lat, lng, seats, route }
//   server → riders: { type:'vehicle_update', driverId, lat, lng, seats, route, type }
//   rider  → server: { type:'subscribe', lat, lng, radius }   (gets nearby vehicles)
//   server → driver: { type:'new_booking', bookingId, riderName, route, fare }

const clients = new Map(); // ws → { role, driverId, lat, lng }

wss.on('connection', (ws) => {
  clients.set(ws, { role: null });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // Driver sends their location every 3–5 seconds
      case 'location': {
        const { driverId, lat, lng, seats, route } = msg;
        clients.set(ws, { role:'driver', driverId, lat, lng });
        // Update PostGIS location in DB
        await db.query(
          `UPDATE drivers SET location=ST_SetSRID(ST_MakePoint($1,$2),4326),
           seats=$3, route_to=$4, online=true, updated_at=NOW() WHERE id=$5`,
          [lng, lat, seats, route, driverId]
        );
        // Fan out to all subscribed riders within 5km
        const broadcast = JSON.stringify({ type:'vehicle_update', driverId, lat, lng, seats, route });
        clients.forEach((meta, client) => {
          if (meta.role === 'rider' && client.readyState === 1) {
            if (!meta.lat || haversine(lat, lng, meta.lat, meta.lng) < 5) {
              client.send(broadcast);
            }
          }
        });
        break;
      }

      // Rider subscribes and gives their location for radius filtering
      case 'subscribe': {
        const { lat, lng } = msg;
        clients.set(ws, { role:'rider', lat, lng });
        // Send nearby vehicles immediately from DB
        const result = await db.query(
          `SELECT id, name, type, route_to, seats, fare,
                  ST_Y(location::geometry) as lat,
                  ST_X(location::geometry) as lng,
                  ST_Distance(location, ST_MakePoint($1,$2)::geography) as dist_m
           FROM drivers
           WHERE online=true
             AND updated_at > NOW() - INTERVAL '2 minutes'
             AND ST_DWithin(location, ST_MakePoint($1,$2)::geography, 5000)
           ORDER BY dist_m ASC
           LIMIT 20`,
          [lng, lat]
        );
        ws.send(JSON.stringify({ type:'nearby_vehicles', vehicles: result.rows }));
        break;
      }
    }
  });

  ws.on('close', () => {
    const meta = clients.get(ws);
    if (meta?.driverId) {
      db.query('UPDATE drivers SET online=false WHERE id=$1', [meta.driverId]);
    }
    clients.delete(ws);
  });
});

// ── REST API ─────────────────────────────────────────────────

// GET /api/nearby?lat=26.14&lng=91.73&radius=3000
app.get('/api/nearby', async (req, res) => {
  const { lat=26.1445, lng=91.7362, radius=5000 } = req.query;
  const result = await db.query(
    `SELECT id, name, type, route_to, seats, fare,
            ST_Y(location::geometry) as lat,
            ST_X(location::geometry) as lng,
            ROUND(ST_Distance(location, ST_MakePoint($1,$2)::geography)) as dist_m
     FROM drivers
     WHERE online=true
       AND updated_at > NOW() - INTERVAL '2 minutes'
       AND ST_DWithin(location, ST_MakePoint($1,$2)::geography, $3)
     ORDER BY dist_m ASC LIMIT 20`,
    [lng, lat, radius]
  );
  res.json({ vehicles: result.rows });
});

// POST /api/book
app.post('/api/book', async (req, res) => {
  const { driverId, riderName, riderPhone, route, fare, payment } = req.body;
  const bookingId = 'JS-' + Math.floor(100000 + Math.random()*900000);
  await db.query(
    `INSERT INTO bookings (id,driver_id,rider_name,rider_phone,route,fare,payment)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [bookingId, driverId, riderName, riderPhone, route, fare, payment]
  );
  // Notify driver via WebSocket
  clients.forEach((meta, ws) => {
    if (meta.role === 'driver' && meta.driverId === driverId && ws.readyState === 1) {
      ws.send(JSON.stringify({ type:'new_booking', bookingId, riderName, route, fare }));
    }
  });
  res.json({ bookingId, status:'confirmed' });
});

// POST /api/driver/register
app.post('/api/driver/register', async (req, res) => {
  const { name, type, phone } = req.body;
  const result = await db.query(
    `INSERT INTO drivers (name,type) VALUES ($1,$2) RETURNING id`,
    [name, type]
  );
  res.json({ driverId: result.rows[0].id });
});

// GET /api/bookings/:driverId
app.get('/api/bookings/:driverId', async (req, res) => {
  const result = await db.query(
    `SELECT * FROM bookings WHERE driver_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [req.params.driverId]
  );
  res.json({ bookings: result.rows });
});

// GET /api/stats/:driverId  (today's earnings)
app.get('/api/stats/:driverId', async (req, res) => {
  const result = await db.query(
    `SELECT COUNT(*) as trips, COALESCE(SUM(fare),0) as earnings
     FROM bookings
     WHERE driver_id=$1
       AND status != 'cancelled'
       AND created_at > NOW() - INTERVAL '1 day'`,
    [req.params.driverId]
  );
  res.json(result.rows[0]);
});

// ── UTILS ────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
setupDB().then(() => {
  server.listen(PORT, () => {
    console.log(`🚌 Jan Saarthi server running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket ready on ws://localhost:${PORT}`);
  });
});
