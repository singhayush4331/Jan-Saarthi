# Jan Saarthi — Full Stack MVP
## सबके लिए सफर · Rides for everyone

---

## What's in this folder

| File | What it is |
|---|---|
| `jan-saarthi.html` | **The complete MVP app** — open this in any browser right now |
| `server.js` | Production Node.js backend with WebSocket + PostgreSQL |
| `package.json` | Node.js dependencies |

---

## Run the HTML MVP right now (zero setup)

Just open `jan-saarthi.html` in your browser.

**To test real-time between Rider and Driver:**
1. Open the file in **two browser tabs**
2. Tab 1 → pick **Rider**
3. Tab 2 → pick **Driver** → go Online → set a route
4. Switch back to Tab 1 — you'll see the live driver appear on the map in real time!

This works because both tabs share `BroadcastChannel` — a browser API that acts like a local WebSocket between tabs. It's the exact same architecture as a real WebSocket server, just local.

---

## Run the production backend

### Requirements
- Node.js 18+
- PostgreSQL 14+ with PostGIS extension
- A Google Maps API key (optional for real map)

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Create .env file
echo "DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/jansaarthi" > .env
echo "PORT=3000" >> .env

# 3. Create the database
psql -U postgres -c "CREATE DATABASE jansaarthi"
psql -U postgres -d jansaarthi -c "CREATE EXTENSION postgis"

# 4. Start the server
npm start
# or for development with auto-reload:
npm run dev
```

### The server auto-creates tables on first run.

---

## How the real-time works

```
Driver app                    Server                    Rider app
    |                           |                           |
    |-- GPS location (WS) ----> |                           |
    |                           |-- PostGIS UPDATE --->DB   |
    |                           |-- broadcast to riders --> |
    |                           |                           |-- map marker moves
    |                           |                           |
    |              <-- new_booking (WS) -------------------|
    |-- accept/decline -------> |                           |
```

- Driver sends location every 3 seconds via WebSocket
- Server runs `ST_DWithin(location, rider_point, 5000)` — finds all drivers within 5km
- Broadcasts to all connected rider clients in that radius
- When rider books: HTTP POST → DB insert → WebSocket push to that driver

---

## Deploy to production (free tier options)

### Option A — Railway.app (easiest, free tier)
```bash
npm install -g @railway/cli
railway login
railway init
railway add postgresql
railway up
```

### Option B — Render.com
1. Push this folder to GitHub
2. Create a new Web Service on render.com
3. Add PostgreSQL database (free tier)
4. Set DATABASE_URL environment variable
5. Deploy

### Option C — Fly.io
```bash
npm install -g flyctl
fly auth login
fly launch
fly postgres create
fly secrets set DATABASE_URL=...
fly deploy
```

---

## API Reference

| Method | Endpoint | What it does |
|---|---|---|
| `GET` | `/api/nearby?lat=26.14&lng=91.73` | Get vehicles within 5km |
| `POST` | `/api/book` | Create a booking |
| `POST` | `/api/driver/register` | Register a new driver |
| `GET` | `/api/bookings/:driverId` | Driver's booking history |
| `GET` | `/api/stats/:driverId` | Today's earnings + trip count |
| `WS` | `ws://yourserver/` | Real-time location stream |

---

## WebSocket message protocol

```javascript
// Driver → Server (every 3-5 seconds)
{ type: 'location', driverId: 'uuid', lat: 26.14, lng: 91.73, seats: 3, route: 'Paltan Bazaar' }

// Rider → Server (on app open)
{ type: 'subscribe', lat: 26.14, lng: 91.73 }

// Server → Rider (location update broadcast)
{ type: 'vehicle_update', driverId: 'uuid', lat: 26.14, lng: 91.73, seats: 3, route: '...' }

// Server → Rider (initial load)
{ type: 'nearby_vehicles', vehicles: [...] }

// Server → Driver (new booking)
{ type: 'new_booking', bookingId: 'JS-123456', riderName: 'Priya', route: '...', fare: 15 }
```

---

## Next features to build

1. **OTP login** — use MSG91 or Fast2SMS (cheap Indian SMS API, Rs.0.15/SMS)
2. **Driver rating** — after trip completes, rider rates 1-5 stars
3. **USSD gateway** — integrate with Airtel or Jio USSD API for feature phones
4. **Route polyline** — draw the vehicle's route on the map using Directions API
5. **Push notifications** — Firebase FCM for booking alerts when app is closed
6. **Payment** — Razorpay or PhonePe payment gateway integration (both free to integrate)
