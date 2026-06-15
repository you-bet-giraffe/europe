import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import { World } from "./world";
import { tileRegistry } from "./tiles";
import type { ClientMessage, ServerMessage } from "../../shared/types";

const PORT            = 4000;
const TICK_RATE       = 20;     // Hz
const TILES_DIR       = process.env.TILES_DIR ?? "";
const INTEREST_RADIUS = 20000;  // m: only sync peers within this range of each client
const MAX_MSG_BYTES   = 4096;   // drop frames larger than this (moves are tiny)
const MAX_MSGS_PER_SEC = 60;    // per-connection budget (client sends ~20/s)

// Derived from world_meta.json at startup; served as /world/meta
let worldMetaPayload: string | null = null;

function loadWorldMeta(): void {
  if (!TILES_DIR) return;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(TILES_DIR, "world_meta.json"), "utf-8"));
    // Grid intervals per tile (tp in the pipeline). Prefer the value the
    // pipeline emits; fall back to the historical constant for older outputs.
    const TILE_PIXELS = raw.tile_pixels ?? 160;
    worldMetaPayload = JSON.stringify({
      tileSize:    raw.tile_size,
      gridOriginX: raw.origin_utm_x - raw.center_utm_x,
      northEdgeZ:  raw.origin_utm_y - raw.center_utm_y,
      tilesX:      Math.ceil(raw.raster_width  / TILE_PIXELS),
      tilesY:      Math.ceil(raw.raster_height / TILE_PIXELS),
    });
  } catch (e) {
    console.warn("Could not read world_meta.json:", (e as Error).message);
  }
}

// ── HTTP server (tiles + health) ──────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tiles: tileRegistry.count }));
    return;
  }

  if (req.url === "/world/meta") {
    if (!worldMetaPayload) { res.writeHead(503); res.end("World meta unavailable"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(worldMetaPayload);
    return;
  }

  // GET /tiles/:x_:y.glb|png   or   /tiles/fine/:x_:y.glb
  const match = req.url?.match(/^\/tiles\/(fine\/)?(\d+)_(\d+)\.(glb|png)$/);
  if (match) {
    if (!TILES_DIR) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("TILES_DIR not configured");
      return;
    }
    const [, fine, x, y, ext] = match;
    const subdir = fine ? "fine_meshes" : (ext === "glb" ? "meshes" : "tiles");
    const filePath = path.join(TILES_DIR, subdir, `${x}_${y}.${ext}`);

    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const contentType = ext === "glb" ? "model/gltf-binary" : "image/png";
      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

// ── WebSocket game server ─────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MSG_BYTES });
const world = new World();
const clients = new Map<string, WebSocket>();

function broadcast(msg: ServerMessage, exclude?: string): void {
  const data = JSON.stringify(msg);
  for (const [id, ws] of clients) {
    if (id !== exclude && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

wss.on("connection", (ws) => {
  const id = randomUUID();
  clients.set(id, ws);
  const player = world.addPlayer(id);

  send(ws, { type: "init", id });
  send(ws, { type: "world_state", players: world.getPlayers() });
  broadcast({ type: "player_joined", player }, id);

  // Per-connection rate limiter: a fixed-window message budget that resets each
  // second. Cheap protection against a client flooding the move channel.
  let msgCount  = 0;
  let windowStart = Date.now();

  ws.on("message", (data) => {
    const now = Date.now();
    if (now - windowStart >= 1000) { windowStart = now; msgCount = 0; }
    if (++msgCount > MAX_MSGS_PER_SEC) return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case "move":
        world.movePlayer(id, msg.position, msg.rotation);
        break;
    }
  });

  ws.on("close", () => {
    clients.delete(id);
    world.removePlayer(id);
    broadcast({ type: "player_left", id });
  });
});

// Each tick, send every client only the peers within its interest radius, so
// world_state bandwidth scales with local crowding rather than the whole world.
setInterval(() => {
  if (clients.size === 0) return;
  for (const [id, ws] of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const me = world.getPlayer(id);
    if (!me) continue;
    const players = world.playersNear(me.position, INTEREST_RADIUS);
    ws.send(JSON.stringify({ type: "world_state", players } satisfies ServerMessage));
  }
}, 1000 / TICK_RATE);

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  loadWorldMeta();
  await tileRegistry.load();
  httpServer.listen(PORT, () => {
    console.log(`Game server running on http://localhost:${PORT}`);
    console.log(`  WebSocket: ws://localhost:${PORT}`);
    console.log(`  Tiles:     http://localhost:${PORT}/tiles/:x_:y.glb`);
    if (!TILES_DIR) console.warn("  Warning: TILES_DIR not set — tile serving disabled");
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
