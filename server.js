const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3000);
const USERNAME = process.env.SITE_USERNAME || "bram";
const PASSWORD = process.env.SITE_PASSWORD || "1234";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret-on-render";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const VEHICLES_FILE = path.join(DATA_DIR, "vehicles.json");
const SESSION_MAX_AGE = 1000 * 60 * 60 * 8;
const VEHICLE_STATUSES = ["Op het oog", "intake en contract", "staat te koop", "verkocht", "gaat niet door"];
const DATABASE_URL = process.env.DATABASE_URL;
const MOBILOX_INVENTORY_URL = process.env.MOBILOX_INVENTORY_URL || "https://occasions.mobilox.nl/3293943-camper-zeeland";

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is verplicht. Koppel een PostgreSQL database op Render.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/i.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false }
});

const sessions = new Map();

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function getSession(request) {
  const cookies = parseCookies(request.headers.cookie);
  const session = sessions.get(cookies.zc_session);

  if (!session || session.expires < Date.now()) {
    if (cookies.zc_session) sessions.delete(cookies.zc_session);
    return null;
  }

  return session;
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 60_000_000) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });

    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function createSessionToken() {
  const nonce = crypto.randomBytes(24).toString("hex");
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(nonce)
    .digest("hex");
}

function ensureSeedFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zeelandcamper_vehicles (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS zeelandcamper_vehicle_photos (
      id TEXT PRIMARY KEY,
      vehicle_id TEXT NOT NULL REFERENCES zeelandcamper_vehicles(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      image_data BYTEA NOT NULL,
      selected BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await seedVehiclesFromJson();
}

async function seedVehiclesFromJson() {
  const result = await pool.query("SELECT COUNT(*)::int AS count FROM zeelandcamper_vehicles");
  if (result.rows[0].count > 0) return;

  ensureSeedFile();
  const content = fs.existsSync(VEHICLES_FILE) ? fs.readFileSync(VEHICLES_FILE, "utf8") : "[]";
  const vehicles = JSON.parse(content || "[]");

  for (const vehicle of vehicles) {
    const normalizedVehicle = {
      ...cleanVehicle(vehicle),
      id: String(vehicle.id || crypto.randomUUID()),
      todos: cleanTodos(vehicle.todos) || [],
      photos: cleanPhotos(vehicle.photos) || [],
      rdwFinnikData: cleanRdwFinnikData(vehicle.rdwFinnikData) || {}
    };
    await upsertVehicle(normalizedVehicle.id, normalizedVehicle);
  }
}

async function readVehicles() {
  const result = await pool.query("SELECT id, data FROM zeelandcamper_vehicles ORDER BY created_at DESC");
  const vehicles = result.rows.map((row) => ({
    id: row.id,
    ...row.data
  }));
  await attachPhotos(vehicles);
  return vehicles;
}

async function readVehicle(id) {
  const result = await pool.query("SELECT id, data FROM zeelandcamper_vehicles WHERE id = $1", [id]);
  if (!result.rows.length) return null;
  const vehicle = {
    id: result.rows[0].id,
    ...result.rows[0].data
  };
  await attachPhotos([vehicle]);
  return vehicle;
}

async function upsertVehicle(id, vehicle) {
  const data = { ...vehicle };
  delete data.id;
  delete data.photos;
  await pool.query(
    `
      INSERT INTO zeelandcamper_vehicles (id, data, created_at, updated_at)
      VALUES ($1, $2::jsonb, NOW(), NOW())
      ON CONFLICT (id)
      DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    `,
    [id, JSON.stringify(data)]
  );
  return readVehicle(id);
}

async function deleteVehicle(id) {
  const result = await pool.query("DELETE FROM zeelandcamper_vehicles WHERE id = $1", [id]);
  return result.rowCount > 0;
}

async function attachPhotos(vehicles) {
  if (!vehicles.length) return;

  const ids = vehicles.map((vehicle) => vehicle.id);
  const result = await pool.query(
    `
      SELECT id, vehicle_id, name, selected, sort_order
      FROM zeelandcamper_vehicle_photos
      WHERE vehicle_id = ANY($1)
      ORDER BY sort_order ASC, created_at ASC
    `,
    [ids]
  );
  const photosByVehicle = new Map(ids.map((id) => [id, []]));

  for (const row of result.rows) {
    photosByVehicle.get(row.vehicle_id)?.push({
      id: row.id,
      name: row.name,
      url: `/vehicle-photos/${encodeURIComponent(row.vehicle_id)}/${encodeURIComponent(row.id)}`,
      selected: row.selected
    });
  }

  for (const vehicle of vehicles) {
    vehicle.photos = photosByVehicle.get(vehicle.id) || [];
  }
}

async function replacePhotoState(vehicleId, photos) {
  for (const [index, photo] of photos.entries()) {
    await pool.query(
      `
        UPDATE zeelandcamper_vehicle_photos
        SET selected = $1, sort_order = $2, name = COALESCE(NULLIF($3, ''), name)
        WHERE id = $4 AND vehicle_id = $5
      `,
      [Boolean(photo.selected), index, String(photo.name || "").trim(), photo.id, vehicleId]
    );
  }
}

async function addVehiclePhotos(vehicleId, photos) {
  const existingCount = await pool.query("SELECT COUNT(*)::int AS count FROM zeelandcamper_vehicle_photos WHERE vehicle_id = $1", [vehicleId]);
  let sortOrder = existingCount.rows[0].count;
  const nextPhotos = [];

  for (const photo of Array.isArray(photos) ? photos : []) {
    const match = String(photo.dataUrl || "").match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (!match) continue;

    const id = crypto.randomUUID();
    const name = String(photo.name || `foto-${sortOrder + 1}${photoExtension(match[1])}`).trim();
    await pool.query(
      `
        INSERT INTO zeelandcamper_vehicle_photos (id, vehicle_id, name, mime_type, image_data, selected, sort_order)
        VALUES ($1, $2, $3, $4, $5, FALSE, $6)
      `,
      [id, vehicleId, name, match[1], Buffer.from(match[2], "base64"), sortOrder]
    );
    nextPhotos.push(id);
    sortOrder += 1;
  }

  return nextPhotos;
}

async function deleteVehiclePhoto(vehicleId, photoId) {
  const result = await pool.query("DELETE FROM zeelandcamper_vehicle_photos WHERE vehicle_id = $1 AND id = $2", [vehicleId, photoId]);
  return result.rowCount > 0;
}

async function readVehiclePhoto(vehicleId, photoId) {
  const result = await pool.query(
    "SELECT name, mime_type, image_data FROM zeelandcamper_vehicle_photos WHERE vehicle_id = $1 AND id = $2",
    [vehicleId, photoId]
  );
  return result.rows[0] || null;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&euro;/g, "€")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteMobiloxUrl(value) {
  const text = decodeHtml(value);
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  return new URL(text, MOBILOX_INVENTORY_URL).toString();
}

function normalizeSyncKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseEuroPrice(value) {
  const prices = [...String(value || "").matchAll(/(?:\u20ac|&euro;)\s*([0-9.\s]+),-/g)]
    .map((match) => match[1].replace(/[^\d]/g, ""))
    .filter(Boolean);
  return prices.at(-1) || "";
}

function parseMobiloxCard(card) {
  const href = card.match(/<a\s+href=("[^"]+"|'[^']+'|[^\s>]+)/i)?.[1]?.replace(/^["']|["']$/g, "") || "";
  const mobiloxId = href.match(/\/(\d+)-[^/]+$/)?.[1] || "";
  const title = decodeHtml(card.match(/<h3[^>]*class=["'][^"']*mox-title[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i)?.[1] || "");
  const imageUrl = absoluteMobiloxUrl(card.match(/<img[^>]+src=("[^"]+"|'[^']+'|[^\s>]+)/i)?.[1]?.replace(/^["']|["']$/g, "") || "");
  const price = parseEuroPrice(card.match(/<div[^>]+class=["'][^"']*mox-price[^"']*["'][\s\S]*?<\/div>/i)?.[0] || card);
  const specs = {};
  const specRegex = /<span[^>]+class=["']?mox-spec-label["']?[^>]*>([\s\S]*?)<\/span>\s*<span[^>]+class=["']?mox-attribute-text["']?[^>]*>([\s\S]*?)<\/span>/gi;
  let match;

  while ((match = specRegex.exec(card))) {
    const label = decodeHtml(match[1]);
    const text = decodeHtml(match[2]);
    if (/kilometer/i.test(text)) specs.mileage = label.replace(/[^\d]/g, "");
    if (/brandstof/i.test(label)) specs.fuel = text;
    if (/bouwjaar/i.test(label)) specs.year = text.replace(/[^\d]/g, "");
    if (/transmissie/i.test(label)) specs.transmission = text;
  }

  if (!mobiloxId || !title) return null;

  return {
    mobiloxId,
    title,
    imageUrl,
    price,
    mileage: specs.mileage || "",
    year: specs.year || "",
    fuel: specs.fuel || "",
    transmission: specs.transmission || "",
    detailUrl: absoluteMobiloxUrl(href)
  };
}

function parseMobiloxInventory(html) {
  return String(html || "")
    .split(/<div class=["']col-lg-4 col-md-6 col-sm-12 mox-product-column["']>/)
    .slice(1)
    .map(parseMobiloxCard)
    .filter(Boolean);
}

async function fetchMobiloxInventory() {
  const response = await fetch(MOBILOX_INVENTORY_URL, {
    headers: {
      "User-Agent": "ZeelandCamper voorraad sync"
    }
  });
  if (!response.ok) throw new Error(`Mobilox voorraad kon niet worden opgehaald (${response.status})`);
  return parseMobiloxInventory(await response.text());
}

function findExistingMobiloxVehicle(vehicles, item) {
  const titleKey = normalizeSyncKey(item.title);

  return vehicles.find((vehicle) => vehicle.mobiloxId === item.mobiloxId)
    || vehicles.find((vehicle) => normalizeSyncKey(vehicle.title) === titleKey && String(vehicle.year || "") === String(item.year || ""));
}

async function syncInventoryFromMobilox() {
  const inventory = await fetchMobiloxInventory();
  const vehicles = await readVehicles();
  const now = new Date().toISOString();
  const activeMobiloxIds = new Set(inventory.map((item) => item.mobiloxId));
  let created = 0;
  let updated = 0;
  let sold = 0;

  for (const item of inventory) {
    const existing = findExistingMobiloxVehicle(vehicles, item);
    const id = existing?.id || `mobilox-${item.mobiloxId}`;
    const nextVehicle = {
      ...(existing || {}),
      id,
      title: item.title,
      year: item.year || existing?.year || "",
      mileage: item.mileage || existing?.mileage || "",
      price: item.price || existing?.price || "",
      status: "staat te koop",
      imageUrl: item.imageUrl || existing?.imageUrl || "",
      source: "Mobilox",
      additionalInfo: existing?.additionalInfo || [
        item.fuel ? `Brandstof: ${item.fuel}` : "",
        item.transmission ? `Transmissie: ${item.transmission}` : ""
      ].filter(Boolean).join("\n"),
      todos: existing?.todos || [],
      rdwFinnikData: existing?.rdwFinnikData || {},
      mobiloxId: item.mobiloxId,
      mobiloxUrl: item.detailUrl,
      mobiloxSynced: true,
      lastInventorySyncAt: now
    };

    await upsertVehicle(id, nextVehicle);
    if (existing) updated += 1;
    else created += 1;
  }

  for (const vehicle of vehicles) {
    if (vehicle.mobiloxSynced && vehicle.mobiloxId && !activeMobiloxIds.has(vehicle.mobiloxId) && vehicle.status === "staat te koop") {
      await upsertVehicle(vehicle.id, {
        ...vehicle,
        status: "verkocht",
        lastInventorySyncAt: now
      });
      sold += 1;
    }
  }

  return {
    ok: true,
    source: MOBILOX_INVENTORY_URL,
    found: inventory.length,
    created,
    updated,
    sold,
    syncedAt: now
  };
}

function cleanTodos(value) {
  if (value === undefined) return undefined;

  let todos = [];
  if (Array.isArray(value)) {
    todos = value;
  } else {
    try {
      todos = JSON.parse(String(value || "[]"));
    } catch (error) {
      todos = [];
    }
  }

  return todos
    .map((todo) => ({
      id: String(todo.id || crypto.randomUUID()),
      text: String(todo.text || "").trim(),
      done: Boolean(todo.done)
    }))
    .filter((todo) => todo.text);
}

function cleanPhotos(value) {
  if (value === undefined) return undefined;
  const photos = Array.isArray(value) ? value : [];

  return photos
    .map((photo) => ({
      id: String(photo.id || crypto.randomUUID()),
      name: String(photo.name || "foto").trim(),
      url: String(photo.url || "").trim(),
      selected: Boolean(photo.selected)
    }))
    .filter((photo) => photo.url);
}

function cleanRdwFinnikData(value) {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value || "{}");
    } catch (error) {
      value = {};
    }
  }

  if (!value || typeof value !== "object") return undefined;

  return {
    fetchedAt: String(value.fetchedAt || "").trim(),
    licensePlate: String(value.licensePlate || "").trim(),
    source: String(value.source || "").trim(),
    make: String(value.make || "").trim(),
    tradeName: String(value.tradeName || "").trim(),
    vehicleType: String(value.vehicleType || "").trim(),
    bodyType: String(value.bodyType || "").trim(),
    fuelType: String(value.fuelType || "").trim(),
    seats: String(value.seats || "").trim(),
    length: String(value.length || "").trim(),
    width: String(value.width || "").trim(),
    height: String(value.height || "").trim(),
    massReady: String(value.massReady || "").trim(),
    emptyMass: String(value.emptyMass || "").trim(),
    maxMass: String(value.maxMass || "").trim(),
    apkUntil: String(value.apkUntil || "").trim(),
    firstAdmission: String(value.firstAdmission || "").trim(),
    firstRegistrationNl: String(value.firstRegistrationNl || "").trim(),
    ownerCount: String(value.ownerCount || "").trim(),
    roadTaxNationalAverage: String(value.roadTaxNationalAverage || "").trim(),
    roadTaxZeeland: String(value.roadTaxZeeland || "").trim(),
    finnikStatus: String(value.finnikStatus || "").trim()
  };
}

function cleanVehicle(input) {
  const status = VEHICLE_STATUSES.includes(input.status) ? input.status : "Op het oog";
  const vehicle = {
    title: String(input.title || "").trim(),
    brand: String(input.brand || "").trim(),
    model: String(input.model || "").trim(),
    year: String(input.year || "").trim(),
    mileage: String(input.mileage || "").trim(),
    price: String(input.price || "").trim(),
    status,
    description: String(input.description || "").trim(),
    imageUrl: String(input.imageUrl || "").trim(),
    sourceId: String(input.sourceId || "").trim(),
    color: String(input.color || "").trim(),
    licensePlate: String(input.licensePlate || "").trim(),
    inspected: String(input.inspected || "").trim(),
    contract: String(input.contract || "").trim(),
    service: String(input.service || "").trim(),
    platform: String(input.platform || "").trim(),
    notes: String(input.notes || "").trim(),
    source: String(input.source || "").trim(),
    funding: String(input.funding || "").trim(),
    purchasePrice: String(input.purchasePrice || "").trim(),
    anwbBovag: String(input.anwbBovag || "").trim(),
    margin: String(input.margin || "").trim(),
    adverts: String(input.adverts || "").trim(),
    costs: String(input.costs || "").trim(),
    invoice: String(input.invoice || "").trim(),
    costsExVat: String(input.costsExVat || "").trim(),
    profitExVat: String(input.profitExVat || "").trim(),
    vatIncluded: String(input.vatIncluded || "").trim(),
    grossProfit: String(input.grossProfit || "").trim(),
    contractUntil: String(input.contractUntil || "").trim(),
    additionalInfo: String(input.additionalInfo || "").trim()
  };

  const todos = cleanTodos(input.todos);
  if (todos !== undefined) {
    vehicle.todos = todos;
  }

  const photos = cleanPhotos(input.photos);
  if (photos !== undefined) {
    vehicle.photos = photos;
  }

  const rdwFinnikData = cleanRdwFinnikData(input.rdwFinnikData);
  if (rdwFinnikData !== undefined) {
    vehicle.rdwFinnikData = rdwFinnikData;
  }

  return vehicle;
}

function normalizeLicensePlate(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function formatDate(value) {
  const text = String(value || "");
  if (text.length !== 8) return text;
  return `${text.slice(6, 8)}-${text.slice(4, 6)}-${text.slice(0, 4)}`;
}

async function lookupRdwData(licensePlate) {
  const kenteken = normalizeLicensePlate(licensePlate);
  const vehicleUrl = `https://opendata.rdw.nl/resource/m9d7-ebf2.json?kenteken=${encodeURIComponent(kenteken)}`;
  const fuelUrl = `https://opendata.rdw.nl/resource/8ys7-d773.json?kenteken=${encodeURIComponent(kenteken)}`;
  const [vehicleResponse, fuelResponse] = await Promise.all([
    fetch(vehicleUrl),
    fetch(fuelUrl)
  ]);

  if (!vehicleResponse.ok) throw new Error("RDW voertuigdata kon niet worden opgehaald");
  const vehicles = await vehicleResponse.json();
  const fuels = fuelResponse.ok ? await fuelResponse.json() : [];
  const rdw = vehicles[0];
  const fuel = fuels[0];

  if (!rdw) return null;

  return {
    licensePlate: kenteken,
    source: "RDW Open Data",
    make: rdw.merk || "",
    tradeName: rdw.handelsbenaming || "",
    vehicleType: rdw.voertuigsoort || "",
    bodyType: rdw.inrichting || "",
    fuelType: fuel?.brandstof_omschrijving || "",
    seats: rdw.aantal_zitplaatsen || "",
    length: rdw.lengte || "",
    width: rdw.breedte || "",
    height: rdw.hoogte_voertuig || "",
    massReady: rdw.massa_rijklaar || "",
    emptyMass: rdw.massa_ledig_voertuig || "",
    maxMass: rdw.toegestane_maximum_massa_voertuig || "",
    apkUntil: formatDate(rdw.vervaldatum_apk),
    firstAdmission: formatDate(rdw.datum_eerste_toelating),
    firstRegistrationNl: formatDate(rdw.datum_eerste_tenaamstelling_in_nederland)
  };
}

async function lookupFinnikData(licensePlate) {
  if (!process.env.FINNIK_API_URL) {
    return {
      ownerCount: "",
      roadTaxNationalAverage: "Niet beschikbaar zonder Finnik koppeling",
      roadTaxZeeland: "Niet beschikbaar zonder Finnik koppeling",
      finnikStatus: "FINNIK_API_URL is niet ingesteld op de server"
    };
  }

  const url = `${process.env.FINNIK_API_URL.replace(/\/$/, "")}/${encodeURIComponent(normalizeLicensePlate(licensePlate))}`;
  const response = await fetch(url, {
    headers: process.env.FINNIK_API_KEY ? { Authorization: `Bearer ${process.env.FINNIK_API_KEY}` } : {}
  });
  if (!response.ok) throw new Error("Finnik data kon niet worden opgehaald");
  const data = await response.json();

  return {
    ownerCount: data.ownerCount || data.aantalEigenaren || "",
    roadTaxNationalAverage: data.roadTaxNationalAverage || data.gemiddeldeWegenbelasting || "",
    roadTaxZeeland: data.roadTaxZeeland || data.zeelandWegenbelasting || "",
    finnikStatus: "Finnik data opgehaald"
  };
}

async function lookupVehicleData(licensePlate) {
  const rdw = await lookupRdwData(licensePlate);
  if (!rdw) return null;
  const finnik = await lookupFinnikData(licensePlate);

  return {
    fetchedAt: new Date().toISOString(),
    ...rdw,
    ...finnik
  };
}

function photoExtension(mimeType, fallbackName = "") {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/jpeg") return ".jpg";
  const ext = path.extname(fallbackName).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
}

function requireSession(request, response) {
  const session = getSession(request);

  if (!session) {
    sendJson(response, 401, { ok: false, message: "Niet ingelogd" });
    return null;
  }

  return session;
}

function serveFile(response, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Niet gevonden" : "Serverfout");
      return;
    }

    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream"
    });
    response.end(data);
  });
}

function resolvePublicPath(urlPath) {
  const requestedPath = urlPath === "/" ? "/index.html" : urlPath;
  const decodedPath = decodeURIComponent(requestedPath.split("?")[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, decodedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return null;
  }

  return filePath;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const vehicleMatch = url.pathname.match(/^\/api\/vehicles\/([^/]+)$/);
  const lookupMatch = url.pathname.match(/^\/api\/lookup\/([^/]+)$/);
  const photoMatch = url.pathname.match(/^\/api\/vehicles\/([^/]+)\/photos$/);
  const photoDeleteMatch = url.pathname.match(/^\/api\/vehicles\/([^/]+)\/photos\/([^/]+)$/);
  const servedPhotoMatch = url.pathname.match(/^\/vehicle-photos\/([^/]+)\/([^/]+)$/);

  if (request.method === "POST" && url.pathname === "/api/login") {
    try {
      const body = await readBody(request);
      const credentials = JSON.parse(body || "{}");

      if (credentials.username !== USERNAME || credentials.password !== PASSWORD) {
        sendJson(response, 401, { ok: false, message: "Ongeldige login" });
        return;
      }

      const token = createSessionToken();
      sessions.set(token, {
        username: USERNAME,
        expires: Date.now() + SESSION_MAX_AGE
      });

      const inventorySync = await syncInventoryFromMobilox().catch((error) => {
        console.error("Mobilox voorraad sync mislukt:", error.message);
        return { ok: false, message: error.message };
      });

      sendJson(response, 200, { ok: true, inventorySync }, {
        "Set-Cookie": `zc_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE / 1000}`
      });
    } catch (error) {
      sendJson(response, 400, { ok: false, message: "Login kon niet worden verwerkt" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/logout") {
    const cookies = parseCookies(request.headers.cookie);
    if (cookies.zc_session) sessions.delete(cookies.zc_session);

    sendJson(response, 200, { ok: true }, {
      "Set-Cookie": "zc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/session") {
    const session = getSession(request);
    sendJson(response, 200, {
      authenticated: Boolean(session),
      username: session?.username || null
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/vehicles") {
    try {
      const vehicles = await readVehicles();
      sendJson(response, 200, { vehicles });
    } catch (error) {
      sendJson(response, 500, { ok: false, message: "Voertuigen konden niet worden geladen" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sync/inventory") {
    if (!requireSession(request, response)) return;

    try {
      const result = await syncInventoryFromMobilox();
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 502, { ok: false, message: error.message || "Voorraad sync mislukt" });
    }
    return;
  }

  if (request.method === "GET" && lookupMatch) {
    if (!requireSession(request, response)) return;

    try {
      const data = await lookupVehicleData(lookupMatch[1]);
      if (!data) {
        sendJson(response, 404, { ok: false, message: "Geen RDW data gevonden voor dit kenteken" });
        return;
      }
      sendJson(response, 200, { ok: true, data });
    } catch (error) {
      sendJson(response, 502, { ok: false, message: error.message || "RDW & Finnik data kon niet worden opgehaald" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/vehicles") {
    if (!requireSession(request, response)) return;

    try {
      const body = await readBody(request);
      const vehicle = cleanVehicle(JSON.parse(body || "{}"));

      if (!vehicle.title) {
        sendJson(response, 400, { ok: false, message: "Titel is verplicht" });
        return;
      }

      const newVehicle = {
        id: crypto.randomUUID(),
        todos: [],
        photos: [],
        rdwFinnikData: {},
        ...vehicle
      };
      const savedVehicle = await upsertVehicle(newVehicle.id, newVehicle);
      sendJson(response, 201, { ok: true, vehicle: savedVehicle });
    } catch (error) {
      sendJson(response, 400, { ok: false, message: "Voertuig kon niet worden opgeslagen" });
    }
    return;
  }

  if (request.method === "PUT" && vehicleMatch) {
    if (!requireSession(request, response)) return;

    try {
      const body = await readBody(request);
      const rawUpdates = JSON.parse(body || "{}");
      const updates = cleanVehicle(rawUpdates);
      const vehicle = await readVehicle(vehicleMatch[1]);

      if (!vehicle) {
        sendJson(response, 404, { ok: false, message: "Voertuig niet gevonden" });
        return;
      }

      if (updates.photos !== undefined) {
        await replacePhotoState(vehicle.id, updates.photos);
      }

      const nextVehicle = {
        ...vehicle,
        ...updates
      };
      delete nextVehicle.photos;
      const savedVehicle = await upsertVehicle(vehicle.id, nextVehicle);
      sendJson(response, 200, { ok: true, vehicle: savedVehicle });
    } catch (error) {
      sendJson(response, 400, { ok: false, message: "Voertuig kon niet worden bijgewerkt" });
    }
    return;
  }

  if (request.method === "POST" && photoMatch) {
    if (!requireSession(request, response)) return;

    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vehicle = await readVehicle(photoMatch[1]);

      if (!vehicle) {
        sendJson(response, 404, { ok: false, message: "Voertuig niet gevonden" });
        return;
      }

      await addVehiclePhotos(vehicle.id, payload.photos);
      const savedVehicle = await readVehicle(vehicle.id);
      sendJson(response, 200, { ok: true, photos: savedVehicle.photos, vehicle: savedVehicle });
    } catch (error) {
      sendJson(response, 400, { ok: false, message: "Foto's konden niet worden opgeslagen" });
    }
    return;
  }

  if (request.method === "DELETE" && photoDeleteMatch) {
    if (!requireSession(request, response)) return;

    try {
      const vehicle = await readVehicle(photoDeleteMatch[1]);

      if (!vehicle) {
        sendJson(response, 404, { ok: false, message: "Voertuig niet gevonden" });
        return;
      }

      const deleted = await deleteVehiclePhoto(vehicle.id, photoDeleteMatch[2]);
      if (!deleted) {
        sendJson(response, 404, { ok: false, message: "Foto niet gevonden" });
        return;
      }

      const savedVehicle = await readVehicle(vehicle.id);
      sendJson(response, 200, { ok: true, photos: savedVehicle.photos, vehicle: savedVehicle });
    } catch (error) {
      sendJson(response, 400, { ok: false, message: "Foto kon niet worden verwijderd" });
    }
    return;
  }

  if (request.method === "DELETE" && vehicleMatch) {
    if (!requireSession(request, response)) return;

    try {
      const deleted = await deleteVehicle(vehicleMatch[1]);
      if (!deleted) {
        sendJson(response, 404, { ok: false, message: "Voertuig niet gevonden" });
        return;
      }

      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 400, { ok: false, message: "Voertuig kon niet worden verwijderd" });
    }
    return;
  }

  if (request.method !== "GET") {
    response.writeHead(405);
    response.end("Methode niet toegestaan");
    return;
  }

  if (servedPhotoMatch) {
    if (!getSession(request)) {
      response.writeHead(302, { Location: "/login.html" });
      response.end();
      return;
    }

    try {
      const photo = await readVehiclePhoto(servedPhotoMatch[1], servedPhotoMatch[2]);
      if (!photo) {
        response.writeHead(404);
        response.end("Niet gevonden");
        return;
      }
      response.writeHead(200, {
        "Content-Type": photo.mime_type,
        "Cache-Control": "private, max-age=3600"
      });
      response.end(photo.image_data);
    } catch (error) {
      response.writeHead(500);
      response.end("Foto kon niet worden geladen");
    }
    return;
  }

  const protectedPages = ["/dashboard", "/dashboard.html", "/camper-detail", "/camper-detail.html", "/showroomkaart", "/showroomkaart.html", "/todos", "/todos.html", "/new-camper", "/new-camper.html", "/op-het-oog", "/op-het-oog.html", "/photos", "/photos.html"];
  if (protectedPages.includes(url.pathname) && !getSession(request)) {
    response.writeHead(302, { Location: "/login.html" });
    response.end();
    return;
  }

  const routeAliases = {
    "/dashboard": "/dashboard.html",
    "/camper-detail": "/camper-detail.html",
    "/showroomkaart": "/showroomkaart.html",
    "/todos": "/todos.html",
    "/new-camper": "/new-camper.html",
    "/op-het-oog": "/op-het-oog.html",
    "/photos": "/photos.html",
    "/login": "/login.html"
  };
  const filePath = resolvePublicPath(routeAliases[url.pathname] || url.pathname);
  if (!filePath) {
    response.writeHead(403);
    response.end("Verboden");
    return;
  }

  serveFile(response, filePath);
});

initDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`ZeelandCamper draait op http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialisatie mislukt:", error);
    process.exit(1);
  });
