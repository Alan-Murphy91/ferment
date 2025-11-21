import express from "express";
import dotenv from "dotenv";
import { sql } from "./db.js";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Parse HTML form bodies
app.use(express.urlencoded({ extended: true }));

// ----------------------
// Helpers
// ----------------------

function locationMultiplier(location) {
  // "speed" relative to room temp
  switch (location) {
    case "counter":
      return 1; // base speed
    case "fridge":
      return 1 / 3; // 3x slower
    default:
      return 1;
  }
}

// Compute "stress units" since last feed, taking moves into account
function calculateFermentStatus(ferment, moveEvents, now = new Date()) {
  const baseInterval = ferment.base_feed_interval_hours;
  const lastFed = new Date(ferment.last_fed_at);

  if (isNaN(lastFed.getTime())) {
    return { stress: 0, ratio: 0, label: "unknown" };
  }

  // Build segments: [last_fed_at -> first move], [move -> move], [last move -> now]
  let cursor = lastFed;
  let currentLocation = ferment.storage_location;
  let stressUnits = 0;

  const events = moveEvents
    .slice()
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

  for (const ev of events) {
    const t = new Date(ev.created_at);
    if (t <= cursor) continue;

    const hours = (t - cursor) / 36e5;
    if (hours > 0) {
      stressUnits += hours * locationMultiplier(currentLocation);
    }

    // Apply move
    if (ev.new_storage_location) {
      currentLocation = ev.new_storage_location;
    }
    cursor = t;
  }

  // Final segment: last event -> now
  const hoursFinal = (now - cursor) / 36e5;
  if (hoursFinal > 0) {
    stressUnits += hoursFinal * locationMultiplier(currentLocation);
  }

  const ratio = stressUnits / baseInterval;

  let label;
  if (!isFinite(ratio)) {
    label = "unknown";
  } else if (ratio < 0.7) {
    label = "happy";
  } else if (ratio < 1.0) {
    label = "due_soon";
  } else {
    label = "needs_feed";
  }

  return { stress: stressUnits, ratio, label };
}

function renderPage(fermentsWithStatus) {
  const rows =
    fermentsWithStatus.length === 0
      ? "<p>No ferments yet.</p>"
      : fermentsWithStatus
          .map(({ ferment, status }) => {
            const started = new Date(ferment.started_at);
            const lastFed = new Date(ferment.last_fed_at);
            const now = new Date();

            const ageDays = (now - started) / (1000 * 60 * 60 * 24);

            const hoursSinceFeed = (now - lastFed) / 36e5;

            const ratioPct = (status.ratio * 100).toFixed(0);

            let statusColour = "#4ade80"; // green
            if (status.label === "due_soon") statusColour = "#fbbf24";
            if (status.label === "needs_feed") statusColour = "#f87171";

            return `
<div style="border:1px solid #ddd;padding:8px;margin-bottom:10px;border-radius:6px;">
  <div style="display:flex;justify-content:space-between;align-items:center;">
    <div>
      <strong>${ferment.name}</strong><br/>
      <small>${ferment.type} · ${ferment.storage_location}</small><br/>
      <small>Age: ${ageDays.toFixed(1)} days</small><br/>
      <small>Last fed: ${lastFed.toLocaleString()} (~${hoursSinceFeed.toFixed(
              1
            )}h ago)</small><br/>
      <small>Base interval: ${
        ferment.base_feed_interval_hours
      }h (room temp)</small>
    </div>
    <div style="text-align:right;">
      <span style="
        display:inline-block;
        padding:2px 8px;
        border-radius:999px;
        background:${statusColour};
        color:#111;
        font-size:12px;
        font-weight:600;
      ">
        ${status.label} (${ratioPct}%)
      </span>
    </div>
  </div>

  <form method="POST" action="/ferments/${
    ferment.id
  }/feed" style="margin-top:8px;display:inline;">
    <button type="submit">Feed now</button>
  </form>

  <form method="POST" action="/ferments/${
    ferment.id
  }/move" style="margin-top:8px;display:inline;margin-left:6px;">
    <input type="hidden" name="to" value="${
      ferment.storage_location === "counter" ? "fridge" : "counter"
    }" />
    <button type="submit">Move to ${
      ferment.storage_location === "counter" ? "fridge" : "counter"
    }</button>
  </form>
</div>
`;
          })
          .join("");

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Ferment Radar</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      background:#f9fafb;
    }
    input, select {
      padding: 4px;
      margin-bottom: 6px;
    }
    button {
      padding: 4px 10px;
      margin-top: 4px;
    }
    .card {
      background:white;
      border-radius:8px;
      box-shadow:0 1px 2px rgba(0,0,0,0.05);
    }
  </style>
</head>
<body>
  <h1>Ferment Radar (local)</h1>

  <h2>Add ferment</h2>
  <form method="POST" action="/ferments" style="margin-bottom:20px;">
    <div>
      <input name="name" placeholder="Name (Berlin wholemeal starter)" required />
    </div>
    <div>
      <label>Type:
        <select name="type">
          <option value="sourdough">sourdough</option>
          <option value="kombucha">kombucha</option>
        </select>
      </label>
      <label style="margin-left:8px;">Location:
        <select name="storage_location">
          <option value="counter">counter</option>
          <option value="fridge">fridge</option>
        </select>
      </label>
    </div>
    <div>
      <label>Base feed interval (hours, at room temp):
        <input type="number" name="base_feed_interval_hours" value="16" min="1" />
      </label>
    </div>
    <div>
      <label>Started at:
        <input type="datetime-local" name="started_at" />
      </label>
    </div>
    <button type="submit">Create ferment</button>
  </form>

  <h2>Ferments</h2>
  ${rows}
</body>
</html>
`;
}

// ----------------------
// Routes
// ----------------------

// Home: list ferments + status
app.get("/", async (req, res) => {
  try {
    const ferments = await sql`
      SELECT id, name, type, storage_location,
             base_feed_interval_hours, last_fed_at, started_at, created_at
      FROM ferments
      ORDER BY created_at ASC
    `;

    // Fetch move events for all ferments since last feed
    const ids = ferments.map((f) => f.id);
    let movesByFerment = {};

    if (ids.length > 0) {
      const rows = await sql`
        SELECT e.id, e.ferment_id, e.event_type, e.new_storage_location, e.created_at
        FROM ferment_events e
        WHERE e.event_type = 'move'
          AND e.ferment_id = ANY (${ids}::uuid[])
      `;

      movesByFerment = rows.reduce((acc, ev) => {
        if (!acc[ev.ferment_id]) acc[ev.ferment_id] = [];
        acc[ev.ferment_id].push(ev);
        return acc;
      }, {});
    }

    const now = new Date();
    const fermentsWithStatus = ferments.map((f) => {
      const moves = movesByFerment[f.id] || [];
      const status = calculateFermentStatus(f, moves, now);
      return { ferment: f, status };
    });

    res.send(renderPage(fermentsWithStatus));
  } catch (err) {
    console.error("GET / error", err);
    res.status(500).send("Server error");
  }
});

// Create ferment
app.post("/ferments", async (req, res) => {
  try {
    const {
      name,
      type,
      storage_location,
      base_feed_interval_hours,
      started_at,
    } = req.body;

    const baseInterval = Number(base_feed_interval_hours) || 16;

    const started =
      started_at && started_at.length > 0
        ? new Date(started_at).toISOString()
        : new Date().toISOString();

    const nowIso = new Date().toISOString();

    await sql`
      INSERT INTO ferments (
        name, type, storage_location,
        base_feed_interval_hours, last_fed_at,
        started_at, created_at
      )
      VALUES (
        ${name},
        ${type},
        ${storage_location},
        ${baseInterval},
        ${nowIso},
        ${started},
        ${nowIso}
      )
    `;

    res.redirect("/");
  } catch (err) {
    console.error("POST /ferments error", err);
    res.status(500).send("Server error");
  }
});

// Feed now: update last_fed_at + log event
app.post("/ferments/:id/feed", async (req, res) => {
  try {
    const id = req.params.id;
    const nowIso = new Date().toISOString();

    await sql`
      UPDATE ferments
      SET last_fed_at = ${nowIso}
      WHERE id = ${id}::uuid
    `;

    await sql`
      INSERT INTO ferment_events (ferment_id, event_type, new_storage_location, created_at)
      VALUES (${id}::uuid, 'feed', NULL, ${nowIso})
    `;

    res.redirect("/");
  } catch (err) {
    console.error("POST /ferments/:id/feed error", err);
    res.status(500).send("Server error");
  }
});

// Move between fridge/counter: update storage_location + log move
app.post("/ferments/:id/move", async (req, res) => {
  try {
    const id = req.params.id;
    const to = req.body.to; // 'fridge' or 'counter'
    const nowIso = new Date().toISOString();

    await sql`
      UPDATE ferments
      SET storage_location = ${to}
      WHERE id = ${id}::uuid
    `;

    await sql`
      INSERT INTO ferment_events (ferment_id, event_type, new_storage_location, created_at)
      VALUES (${id}::uuid, 'move', ${to}, ${nowIso})
    `;

    res.redirect("/");
  } catch (err) {
    console.error("POST /ferments/:id/move error", err);
    res.status(500).send("Server error");
  }
});

app.listen(port, () => {
  console.log(`Ferment app running on http://localhost:${port}`);
});
