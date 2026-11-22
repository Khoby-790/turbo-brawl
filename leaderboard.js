// Best-lap leaderboard. Stores every driver's best lap per track and serves the top 10.
//
// Storage:
//   DATABASE_URL set  -> PostgreSQL (e.g. a free Neon or Supabase database). Survives redeploys.
//   otherwise         -> a JSON file in DATA_DIR (default ./data). Wiped on hosts with temporary disks.
//
// Reads are served from an in-memory cache so lap messages are instant; writes go to storage
// in the background.
const fs = require('fs');
const path = require('path');

const BOARD_SIZE = 10;

function createLeaderboard({ databaseUrl, dataDir, log = console }) {
  let board = {};   // track name -> top entries [{ name, car, ms, at }]
  let backend = null;

  // ---------- shared cache logic ----------
  const keyOf = name => name.trim().toLowerCase();
  // Returns the driver's rank (1-based) if this lap is a personal best that makes the top 10, else 0.
  function submit(track, name, car, ms) {
    const list = board[track] || (board[track] = []);
    const key = keyOf(name);
    const prev = list.find(e => keyOf(e.name) === key);
    if (prev && prev.ms <= ms) return 0;
    // always persist a personal best, even if it doesn't make the visible top 10
    backend.save(track, key, name, car, ms).catch(err => log.error('leaderboard save failed:', err.message));
    const next = list.filter(e => keyOf(e.name) !== key);
    next.push({ name, car, ms, at: Date.now() });
    next.sort((a, b) => a.ms - b.ms);
    board[track] = next.slice(0, BOARD_SIZE);
    return board[track].findIndex(e => keyOf(e.name) === key) + 1;
  }
  const record = track => (board[track] && board[track][0]) || null;
  const all = () => board;

  // ---------- file backend ----------
  function fileBackend() {
    const file = path.join(dataDir, 'leaderboard.json');
    let all = {}; // track -> { key: entry } (every driver's best, not just the top 10)
    let timer = null;
    const flush = () => {
      fs.mkdir(dataDir, { recursive: true }, () => {
        const tmp = file + '.tmp';
        fs.writeFile(tmp, JSON.stringify(all), err => {
          if (err) return log.error('leaderboard write failed:', err.message);
          fs.rename(tmp, file, () => {});
        });
      });
    };
    return {
      name: 'file ' + file,
      async load() {
        try {
          const raw = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
          for (const t in raw) {
            // accept both the old format (array of top entries) and the new one (map of all drivers)
            all[t] = Array.isArray(raw[t]) ? Object.fromEntries(raw[t].map(e => [keyOf(e.name), e])) : raw[t];
          }
        } catch { all = {}; }
        const out = {};
        for (const t in all) out[t] = Object.values(all[t]).sort((a, b) => a.ms - b.ms).slice(0, BOARD_SIZE);
        return out;
      },
      async save(track, key, name, car, ms) {
        (all[track] || (all[track] = {}))[key] = { name, car, ms, at: Date.now() };
        clearTimeout(timer); timer = setTimeout(flush, 1000);
      },
    };
  }

  // ---------- PostgreSQL backend ----------
  function pgBackend() {
    const { Pool } = require('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: true }, max: 3, idleTimeoutMillis: 30000 });
    pool.on('error', err => log.error('database connection error:', err.message));
    return {
      name: 'postgres',
      async load() {
        await pool.query(`CREATE TABLE IF NOT EXISTS lap_records (
          track    TEXT    NOT NULL,
          name_key TEXT    NOT NULL,
          name     TEXT    NOT NULL,
          car      TEXT    NOT NULL,
          ms       INTEGER NOT NULL,
          set_at   BIGINT  NOT NULL,
          PRIMARY KEY (track, name_key))`);
        const { rows } = await pool.query(`SELECT track, name, car, ms, set_at FROM (
            SELECT *, row_number() OVER (PARTITION BY track ORDER BY ms, set_at) AS rn FROM lap_records) t
          WHERE rn <= $1 ORDER BY track, ms`, [BOARD_SIZE]);
        const out = {};
        for (const r of rows) (out[r.track] || (out[r.track] = [])).push({ name: r.name, car: r.car, ms: r.ms, at: Number(r.set_at) });
        return out;
      },
      async save(track, key, name, car, ms) {
        // keep the faster of the stored and new lap
        await pool.query(`INSERT INTO lap_records (track, name_key, name, car, ms, set_at) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (track, name_key) DO UPDATE SET name = EXCLUDED.name, car = EXCLUDED.car, ms = EXCLUDED.ms, set_at = EXCLUDED.set_at
          WHERE lap_records.ms > EXCLUDED.ms`, [track, key, name, car, ms, Date.now()]);
      },
      end: () => pool.end(),
    };
  }

  async function init() {
    if (databaseUrl) {
      try {
        backend = pgBackend();
        board = await backend.load();
        log.log(`Leaderboard: using PostgreSQL (${Object.keys(board).length} tracks with records)`);
        return;
      } catch (err) {
        log.error('Leaderboard: could not use the database, falling back to a local file:', err.message);
        if (backend && backend.end) backend.end().catch(() => {});
      }
    }
    backend = fileBackend();
    board = await backend.load();
    log.log(`Leaderboard: using ${backend.name}` + (databaseUrl ? '' : ' (set DATABASE_URL to keep records across redeploys)'));
  }

  return { init, submit, record, all, get backend() { return backend && backend.name; }, close: () => backend && backend.end && backend.end() };
}

module.exports = { createLeaderboard, BOARD_SIZE };
