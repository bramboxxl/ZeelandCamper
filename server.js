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
const SHOWROOM_TEMPLATE_FILE = path.join(DATA_DIR, "Word briefpapier ZeelandCamper.docx");
const SESSION_MAX_AGE = 1000 * 60 * 60 * 8;
const VEHICLE_STATUSES = ["Op het oog", "intake en contract", "staat te koop", "verkocht", "gaat niet door"];
const DATABASE_URL = process.env.DATABASE_URL;
const MOBILOX_INVENTORY_URL = process.env.MOBILOX_INVENTORY_URL || "https://occasions.mobilox.nl/3293943-camper-zeeland";
const MOBILOX_API_URL = process.env.MOBILOX_API_URL || "https://api.mobilox.nl/api/v2/";
const MOBILOX_EMAIL = process.env.MOBILOX_EMAIL;
const MOBILOX_PASSWORD = process.env.MOBILOX_PASSWORD;

if (!DATABASE_URL && require.main === module) {
  throw new Error("DATABASE_URL is verplicht. Koppel een PostgreSQL database op Render.");
}

const pool = DATABASE_URL
  ? new Pool({
    connectionString: DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/i.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false }
  })
  : null;

const sessions = new Map();

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
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

function normalizeLicensePlateKey(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
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

function normalizeShowroomText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/g, " ")
    .replace(/&euro;/g, "€")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[🚐🛋️🍳🌡️💡🚗🏕️⚙️]/gu, "")
    .replace(/[✔✅]/g, "-")
    .replace(/\u2003/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
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
    signal: AbortSignal.timeout(10000),
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
  let removed = 0;

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
      licensePlate: normalizeLicensePlateKey(existing?.licensePlate || ""),
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
    const isCurrentMobiloxVehicle = vehicle.mobiloxId && activeMobiloxIds.has(String(vehicle.mobiloxId));
    const keepWatchVehicle = vehicle.status === "Op het oog" || vehicle.status === "intake en contract";

    if (!isCurrentMobiloxVehicle && !keepWatchVehicle) {
      await deleteVehicle(vehicle.id);
      removed += 1;
    }
  }

  return {
    ok: true,
    source: MOBILOX_INVENTORY_URL,
    found: inventory.length,
    created,
    updated,
    removed,
    syncedAt: now
  };
}

async function findVehicleByLicensePlate(licensePlate) {
  const key = normalizeLicensePlateKey(licensePlate);
  if (!key) return null;

  let vehicles = await readVehicles();
  let vehicle = vehicles.find((item) => normalizeLicensePlateKey(item.licensePlate) === key);
  if (vehicle?.mobiloxUrl) return vehicle;

  await syncInventoryFromMobilox().catch((error) => {
    console.error("Mobilox voorraad sync mislukt:", error.message);
  });

  vehicles = await readVehicles();
  vehicle = vehicles.find((item) => normalizeLicensePlateKey(item.licensePlate) === key);
  return vehicle || null;
}

async function fetchText(urlToFetch) {
  const response = await fetch(urlToFetch, {
    headers: {
      "User-Agent": "ZeelandCamper showroomkaart"
    }
  });
  if (!response.ok) throw new Error(`Mobilox pagina kon niet worden opgehaald (${response.status})`);
  return response.text();
}

async function fetchImageBuffer(imageUrl) {
  const response = await fetch(imageUrl, {
    headers: {
      "User-Agent": "ZeelandCamper showroomkaart"
    }
  });
  if (!response.ok) throw new Error(`Foto kon niet worden opgehaald (${response.status})`);
  const contentType = response.headers.get("content-type") || "image/jpeg";
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType
  };
}

function parseSetCookie(header) {
  return [...String(header || "").matchAll(/(?:^|,\s*)(PHPSESSID|API_REMEMBER)=([^;,]+)/g)]
    .map((match) => `${match[1]}=${match[2]}`)
    .join("; ");
}

async function mobiloxLogin(credentials = {}) {
  credentials = credentials || {};
  const email = String(credentials.email || MOBILOX_EMAIL || "").trim();
  const password = String(credentials.password || MOBILOX_PASSWORD || "");

  if (!email || !password) {
    const error = new Error("MOBILOX_EMAIL en MOBILOX_PASSWORD zijn nodig voor de Mobilox Voorbeeld-tekst");
    error.code = "missing_mobilox_credentials";
    error.status = 500;
    throw error;
  }

  const body = new URLSearchParams({
    _username: email,
    _password: password,
    _remember_me: "on"
  });
  const response = await fetch("https://api.mobilox.nl/login?redirect_to=https%3A%2F%2Fmembers.mobilox.nl%2F&redirect_failure=https%3A%2F%2Fmembers.mobilox.nl%2Flogin", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "ZeelandCamper showroomkaart"
    },
    body,
    redirect: "manual"
  });
  const cookie = parseSetCookie(response.headers.get("set-cookie"));

  if (!cookie || response.status < 300 || response.status >= 400) {
    const error = new Error("Inloggen bij Mobilox is mislukt");
    error.status = 502;
    throw error;
  }

  return cookie;
}

async function mobiloxFetchJson(cookie, pathName, options = {}) {
  const base = MOBILOX_API_URL.replace(/\/+$/, "");
  const urlToFetch = `${base}/${String(pathName).replace(/^\/+/, "")}`;
  const response = await fetch(urlToFetch, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      Cookie: cookie,
      "User-Agent": "ZeelandCamper showroomkaart",
      ...(options.headers || {})
    },
    body: options.body
  });
  const text = await response.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!response.ok) {
    const error = new Error(json?.message || `Mobilox API gaf status ${response.status}`);
    error.status = 502;
    throw error;
  }

  return json;
}

function getMobiloxProductId(vehicle) {
  const fromField = String(vehicle.mobiloxId || "").replace(/[^\d]/g, "");
  if (fromField) return fromField;
  const fromId = String(vehicle.id || "").match(/(?:mobilox-)?(\d+)/i)?.[1] || "";
  if (fromId) return fromId;
  const fromUrl = String(vehicle.mobiloxUrl || "").match(/\/(\d+)-[^/]+$/)?.[1] || "";
  if (fromUrl) return fromUrl;
  return "";
}

async function fetchMobiloxPreview(vehicle, credentials = {}) {
  const productId = getMobiloxProductId(vehicle);
  if (!productId) {
    const error = new Error("Geen Mobilox product-id gevonden voor deze camper");
    error.status = 404;
    throw error;
  }

  const cookie = await mobiloxLogin(credentials);
  const product = await mobiloxFetchJson(cookie, `products/${encodeURIComponent(productId)}`);
  if (!product || typeof product !== "object") {
    const error = new Error("Mobilox voertuig kon niet worden opgehaald. Controleer de Mobilox inlog.");
    error.status = 502;
    throw error;
  }
  const advertisement = product.advertisement;
  const locale = advertisement?.locales?.[0] || "nl_NL";

  if (!advertisement?.id) {
    const error = new Error("Geen Mobilox advertentie gevonden voor deze camper");
    error.status = 404;
    throw error;
  }

  const query = new URLSearchParams({
    title: advertisement.title?.[locale] || product.title || vehicle.title || "Camper",
    content: advertisement.content?.[locale] || "",
    defaultTextId: "",
    locale
  });
  const preview = await mobiloxFetchJson(cookie, `ats/${encodeURIComponent(advertisement.id)}/preview?${query}`);

  return {
    title: preview.title || product.title || vehicle.title || "Camper",
    contentHtml: preview.content || "",
    text: normalizePreviewHtml(preview.content || ""),
    imageUrl: product.picture || product.pictureOriginal || vehicle.imageUrl || ""
  };
}

function normalizePreviewHtml(html) {
  const withHeadingBreaks = String(html || "").replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (match, tag, inner, offset, source) => {
    const text = decodeHtml(String(inner || "").replace(/<[^>]+>/g, "")).trim();
    const after = String(source || "").slice(offset + match.length, offset + match.length + 24);
    const isLabel = /^\s*(?:&nbsp;|\u00a0)*\s*:/i.test(after);
    const isHeading = text && text.length <= 42 && !/[0-9€:]/.test(text) && !isLabel;
    return isHeading ? `${inner}\n` : inner;
  });

  return withHeadingBreaks
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "")
    .replace(/<\/ul>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/g, " ")
    .replace(/&euro;/g, "€")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&ndash;/g, "-")
    .replace(/\u00a0/g, " ")
    .replace(/\n+\s*:\s*/g, ": ")
    .replace(/([.!?])([A-ZÀ-Ý][a-zà-ÿ])/g, "$1\n$2")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseMobiloxDetail(html, fallbackVehicle) {
  const title = decodeHtml(
    String(html).match(/<h2[^>]*class=["'][^"']*main-title[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i)?.[1]
    || String(html).match(/<title>([\s\S]*?)<\/title>/i)?.[1]
    || fallbackVehicle.title
  );
  const priceText = decodeHtml(
    String(html).match(/<span[^>]*class=["'][^"']*mox-detail-price[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]
    || ""
  );
  const price = parseEuroPrice(priceText) || fallbackVehicle.price || "";
  const descriptionHtml = String(html).match(/<div[^>]*id=["']?descBody["']?[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "";
  const description = normalizeShowroomText(descriptionHtml || fallbackVehicle.description || fallbackVehicle.additionalInfo || fallbackVehicle.notes);
  const imageUrl = absoluteMobiloxUrl(
    String(html).match(/<a[^>]*class=["'][^"']*mox-show-gallery[^"']*["'][^>]*href=("[^"]+"|'[^']+'|[^\s>]+)/i)?.[1]?.replace(/^["']|["']$/g, "")
    || String(html).match(/"uri":"([^"]+)"/i)?.[1]?.replaceAll("\\/", "/")
    || fallbackVehicle.imageUrl
  );
  const specs = parseMobiloxDetailSpecs(html, fallbackVehicle);

  return {
    title: title || fallbackVehicle.title || "Camper",
    price,
    imageUrl,
    description,
    specs
  };
}

function parseMobiloxDetailSpecs(html, vehicle) {
  const text = decodeHtml(html);
  const rdw = vehicle.rdwFinnikData && typeof vehicle.rdwFinnikData === "object" ? vehicle.rdwFinnikData : {};
  const pairs = [
    ["Kenteken", vehicle.licensePlate || rdw.licensePlate],
    ["Bouwjaar", String(vehicle.year || rdw.firstAdmission || "").match(/\d{4}/)?.[0] || ""],
    ["Kilometerstand", formatDisplayMileage(vehicle.mileage)],
    ["Brandstof", rdw.fuelType || text.match(/Brandstof\s+([A-Za-z]+)/i)?.[1] || ""],
    ["Transmissie", text.match(/Transmissie\s+([A-Za-z]+)/i)?.[1] || ""],
    ["Zitplaatsen", rdw.seats || ""],
    ["Afmetingen", formatDisplayDimensions(rdw)]
  ].filter(([, value]) => String(value || "").trim());

  return pairs;
}

function formatDisplayMileage(value) {
  const number = Number(String(value || "").replace(/[^\d]/g, ""));
  if (!number) return "";
  return `${new Intl.NumberFormat("nl-NL").format(number)} km`;
}

function formatDisplayDimensions(data) {
  const parts = [
    data.length ? `${data.length} cm` : "",
    data.width ? `${data.width} cm` : "",
    data.height ? `${data.height} cm` : ""
  ].filter(Boolean);
  return parts.join(" x ");
}

function formatDisplayPrice(value) {
  const number = Number(String(value || "").replace(/[^\d]/g, ""));
  if (!number) return "Prijs op aanvraag";
  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0
  }).format(number);
}

async function createShowroomCardDocx(input) {
  const vehicle = await findVehicleForShowroom(input);
  if (!vehicle) {
    const error = new Error("Geen camper gevonden voor deze showroomkaart");
    error.status = 404;
    throw error;
  }

  const preview = await fetchMobiloxPreview(vehicle);
  if (!preview.text) {
    const error = new Error("Geen tekst gevonden in het Mobilox Voorbeeld-scherm");
    error.status = 422;
    throw error;
  }

  const image = preview.imageUrl ? await fetchImageBuffer(preview.imageUrl) : null;
  const docx = buildShowroomDocx({
    vehicle,
    detail: {
      title: preview.title,
      price: "",
      imageUrl: preview.imageUrl,
      description: preview.text,
      specs: []
    },
    image
  });
  const requestedLicensePlate = input && typeof input === "object" ? input.licensePlate : input;
  const fileLicensePlate = normalizeLicensePlateKey(vehicle.licensePlate || requestedLicensePlate || extractLicensePlateFromPreview(preview.text));
  const fileBase = `${fileLicensePlate || getMobiloxProductId(vehicle) || "camper"} showroomkaart`;

  return {
    fileName: `${fileBase}.docx`,
    buffer: docx
  };
}

async function findVehicleForShowroom(input) {
  if (input && typeof input === "object") {
    const vehicleId = String(input.vehicleId || input.id || "").trim();
    if (vehicleId) {
      const vehicle = await readVehicle(vehicleId);
      if (vehicle) return vehicle;
    }

    return findVehicleByLicensePlate(input.licensePlate);
  }

  return findVehicleByLicensePlate(input);
}

function extractLicensePlateFromPreview(text) {
  const match = String(text || "").match(/\bKenteken:\s*([A-Z0-9-]+)/i);
  return match?.[1] || "";
}

function buildShowroomDocx({ vehicle, detail, image }) {
  const template = fs.existsSync(SHOWROOM_TEMPLATE_FILE)
    ? readZipEntries(fs.readFileSync(SHOWROOM_TEMPLATE_FILE))
    : createEmptyDocxEntries();
  const relsPath = "word/_rels/document.xml.rels";
  const contentTypesPath = "[Content_Types].xml";
  const documentPath = "word/document.xml";
  const relId = nextRelationshipId(template.get(relsPath)?.data?.toString("utf8") || "");
  const imageExt = imageExtension(image?.contentType);
  const imageName = `showroom-photo${imageExt}`;
  const cleanedDescription = removeShowroomContactText(detail.description);
  const textLength = cleanedDescription.length;
  const bodyFontSize = textLength > 5200 ? 16 : textLength > 3800 ? 18 : 20;
  const layout = showroomLayout(detail.title, cleanedDescription);

  if (image?.buffer?.length) {
    template.set(`word/media/${imageName}`, {
      data: image.buffer,
      method: 0
    });
    template.set(relsPath, {
      data: Buffer.from(addRelationship(template.get(relsPath)?.data?.toString("utf8") || defaultDocumentRels(), relId, `media/${imageName}`)),
      method: 0
    });
    template.set(contentTypesPath, {
      data: Buffer.from(addImageContentType(template.get(contentTypesPath)?.data?.toString("utf8") || defaultContentTypes(), imageExt, image.contentType)),
      method: 0
    });
  }

  const originalDocumentXml = ensureDrawingNamespaces(template.get(documentPath)?.data?.toString("utf8") || documentXml(defaultSectPr()));
  const sectPr = showroomSectPr(extractSectPr(originalDocumentXml) || defaultSectPr());
  const imageSize = image?.buffer?.length ? fixedImageWidth(image.buffer, 5040000) : null;
  const imageXml = imageSize ? imageDrawingXml(relId, imageSize.cx, imageSize.cy) : "";

  const bodyXml = [
    paragraphXml(detail.title, { size: 30, bold: true, color: "060250", after: 70, line: 300, align: "center" }),
    imageXml,
    imageXml ? blankParagraphXml({ size: 20, line: 180 }) : "",
    layout.specs.length ? keyValueColumnsXml(layout.specs, { columns: textLength > 3800 ? 3 : 2, size: bodyFontSize, before: imageXml ? 45 : 0 }) : "",
    showroomRemainingXml(layout.remaining, bodyFontSize, textLength, layout.sections),
    sectPr
  ].join("");

  template.set(documentPath, {
    data: Buffer.from(replaceDocumentBodyContent(originalDocumentXml, bodyXml)),
    method: 0
  });

  return writeZipEntries(template);
}

function removeShowroomContactText(text) {
  const lines = String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const cutIndex = lines.findIndex((line) => /^(Bezichtiging & contact|Openingstijden)$/i.test(line) || /^We hebben ons uiterste best gedaan/i.test(line));
  return (cutIndex >= 0 ? lines.slice(0, cutIndex) : lines).join("\n");
}

function showroomLayout(title, text) {
  const lines = normalizeShowroomLineBreaks(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index) => !(index === 0 && normalizeSyncKey(line) === normalizeSyncKey(title)))
    .slice(0, 220);
  const specs = [];
  const sections = [];
  const remaining = [];
  let index = 0;

  while (index < lines.length && !headingLikeLine(lines[index])) {
    const parsed = parseKeyValueLine(lines[index]);
    if (parsed) specs.push(parsed);
    else remaining.push(lines[index]);
    index += 1;
  }

  while (index < lines.length) {
    const heading = lines[index];
    if (!headingLikeLine(heading)) {
      remaining.push(heading);
      index += 1;
      continue;
    }

    const items = [];
    index += 1;
    while (index < lines.length && !headingLikeLine(lines[index])) {
      if (parseKeyValueLine(lines[index])) break;
      items.push(lines[index]);
      index += 1;
    }

    if (items.length) sections.push({ heading, items });
    else remaining.push(heading);
  }

  return { specs, sections, remaining };
}

function normalizeShowroomLineBreaks(text) {
  return String(text || "")
    .replace(/(\b\d{1,3}(?:\.\d{3})*,\d{2})(?=3 maanden technische garantie)/gi, "$1\n")
    .replace(/(€\s*[\d.]+,\d{2})(?=3 maanden technische garantie)/gi, "$1\n")
    .replace(/(Prijs inclusief zekerhedenpakket[^\n]*?€\s*[\d.]+,\d{2})\s*(3 maanden technische garantie)/gi, "$1\n$2")
    .replace(/(Als-is prijs[^\n]*?€\s*[\d.]+,\d{2})\s*(Bij deze prijs)/gi, "$1\n$2");
}

function parseKeyValueLine(line) {
  const match = String(line || "").match(/^([^:]{2,36}):\s*(.+)$/);
  if (!match) return null;
  return [match[1].trim(), match[2].trim()];
}

function headingLikeLine(text) {
  const value = String(text || "").trim();
  if (!value || value.includes(":")) return false;
  if (value.length > 42) return false;
  return /^(Comfort|Exterieur|Infotainment|Interieur|Overige|Belangrijkste kenmerken|Comfortabel interieur|Extra uitrusting|Onderhoud & veiligheid)$/i.test(value);
}

function paragraphOptionsForShowroomLine(text, bodyFontSize, textLength) {
  const value = String(text || "").trim();
  const isHeading = headingLikeLine(value);
  const isPrice = /^(Als-is prijs|Prijs inclusief zekerhedenpakket)/i.test(value);
  const isPackageIntro = /^Bij deze prijs wordt/i.test(value);
  const isPackageItem = /^(3 maanden technische garantie|een volledig jaar APK|was en poetsbeurt|door de fabrikant|de tenaamstelling|oplossen inspectiepunten|6 of 12 maanden garantie)/i.test(value);

  return {
    size: isPrice ? bodyFontSize + 2 : bodyFontSize,
    bold: isHeading || isPrice,
    color: isPrice ? "060250" : "",
    before: isHeading ? 62 : isPrice ? 90 : isPackageIntro ? 22 : isPackageItem ? 4 : 12,
    after: isHeading ? 18 : isPrice ? 30 : isPackageIntro ? 30 : isPackageItem ? 6 : 12,
    line: textLength > 5200 ? 190 : 205
  };
}

function showroomRemainingXml(lines, bodyFontSize, textLength, sections = []) {
  const priceIndex = lines.findIndex((text) => /^(Als-is prijs)/i.test(String(text || "").trim()));
  if (priceIndex < 0) {
    return [
      sectionColumnsXml(sections, { columns: 3, size: bodyFontSize }),
      lines.map((text) => paragraphXml(text, paragraphOptionsForShowroomLine(text, bodyFontSize, textLength))).join("")
    ].join("");
  }

  const beforePrice = lines.slice(0, priceIndex);
  const priceLines = lines.slice(priceIndex);
  const priceBlockEnd = pricePackageEndIndex(priceLines);
  const priceBlock = priceLines.slice(0, priceBlockEnd);
  const afterPrice = [
    ...priceLines.slice(priceBlockEnd).map((text) => ({ text, bullet: false })),
    ...flattenShowroomSections(sections),
    ...beforePrice.map((text) => ({ text, bullet: false }))
  ];
  const { columnItems, proseItems } = splitColumnAndProseItems(afterPrice);

  return pageBreakXml()
    + pricePackageBlockXml(priceBlock, { size: 24 })
    + blankParagraphXml({ size: 20, line: 180 })
    + horizontalRuleXml()
    + blankParagraphXml({ size: 20, line: 180 })
    + twoColumnTextXml(columnItems, {
    size: 20,
    textLength
  })
    + fullWidthProseBlockXml(proseItems, { size: 20 });
}

function flattenShowroomSections(sections) {
  return sections.flatMap((section) => [
    { text: section.heading, bullet: false },
    ...section.items.map((item) => ({ text: item, bullet: !proseLikeLine(item) }))
  ]);
}

function splitColumnAndProseItems(items) {
  return items.reduce((result, item) => {
    const text = String(item?.text || item || "").trim();
    if (!text) return result;

    if (item.bullet || headingLikeLine(text)) {
      result.columnItems.push({ text, bullet: Boolean(item.bullet) });
    } else {
      result.proseItems.push(text);
    }
    return result;
  }, { columnItems: [], proseItems: [] });
}

function proseLikeLine(text) {
  const value = String(text || "").trim();
  return /^Kortom\b/i.test(value) || value.length > 120;
}

function pricePackageEndIndex(lines) {
  const fallbackEnd = Math.min(lines.length, 10);
  const stopIndex = lines.findIndex((line, index) => index > 0 && headingLikeLine(line));
  if (stopIndex > 0) return stopIndex;

  const packageEnd = lines.findIndex((line, index) => index > 0 && /6 of 12 maanden garantie/i.test(String(line || "")));
  if (packageEnd >= 0) return packageEnd + 1;

  return fallbackEnd;
}

function escapeXml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function paragraphXml(text, options = {}) {
  const size = options.size || 21;
  const spacing = `<w:spacing w:before="${options.before || 0}" w:after="${options.after ?? 60}" w:line="${options.line || 250}" w:lineRule="auto"/>`;
  const justification = options.align ? `<w:jc w:val="${options.align}"/>` : "";
  const indent = options.bullet ? '<w:ind w:left="260" w:hanging="180"/>' : "";
  const bold = options.bold ? "<w:b/>" : "";
  const color = options.color ? `<w:color w:val="${options.color}"/>` : "";
  const bulletRun = options.bullet && String(text || "").trim()
    ? `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">• </w:t></w:r>`
    : "";

  return `
    <w:p>
      <w:pPr>${spacing}${justification}${indent}</w:pPr>
      ${bulletRun}
      <w:r>
        <w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>${bold}${color}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>
        <w:t xml:space="preserve">${escapeXml(text)}</w:t>
      </w:r>
    </w:p>`;
}

function pageBreakXml() {
  return `
    <w:p>
      <w:pPr><w:spacing w:before="0" w:after="0" w:line="1" w:lineRule="auto"/></w:pPr>
      <w:r><w:br w:type="page"/></w:r>
    </w:p>`;
}

function blankParagraphXml(options = {}) {
  return paragraphXml("", {
    size: options.size || 20,
    before: 0,
    after: 0,
    line: options.line || 200
  });
}

function horizontalRuleXml() {
  return `
    <w:p>
      <w:pPr>
        <w:spacing w:before="0" w:after="0" w:line="1" w:lineRule="auto"/>
        <w:pBdr><w:bottom w:val="single" w:sz="8" w:space="1" w:color="B8B8B8"/></w:pBdr>
      </w:pPr>
    </w:p>`;
}

function twoColumnTextXml(lines, options = {}) {
  if (!lines.length) return "";

  const columns = 2;
  const tableWidth = options.width || 9000;
  const cellWidth = Math.floor(tableWidth / columns);
  const normalizedLines = lines.map((line) => typeof line === "object" && line !== null ? line : { text: line, bullet: false });
  const splitIndex = Math.ceil(normalizedLines.length / columns);
  const columnLines = [normalizedLines.slice(0, splitIndex), normalizedLines.slice(splitIndex)];

  const rowXml = `
    <w:tr>
      ${columnLines.map((items) => `<w:tc>
        <w:tcPr><w:tcW w:w="${cellWidth}" w:type="dxa"/><w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="60" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="160" w:type="dxa"/></w:tcMar></w:tcPr>
        ${items.map((item, index) => {
          const text = item.text || "";
          const paragraphOptions = paragraphOptionsForShowroomLine(text, options.size || 17, options.textLength || 0);
          return paragraphXml(text, {
            ...paragraphOptions,
            bullet: Boolean(item.bullet),
            before: index === 0 ? 0 : Math.min(paragraphOptions.before || 0, 32),
            after: Math.min(paragraphOptions.after || 0, 18),
            line: Math.min(paragraphOptions.line || 190, 185)
          });
        }).join("")}
      </w:tc>`).join("")}
    </w:tr>`;

  return tableXml(rowXml, columns, cellWidth, { width: tableWidth, before: 0, after: 0 });
}

function fullWidthProseBlockXml(lines, options = {}) {
  if (!lines.length) return "";

  const tableWidth = options.width || 9000;
  const size = options.size || 20;
  const rowXml = `
    <w:tr>
      <w:tc>
        <w:tcPr><w:tcW w:w="${tableWidth}" w:type="dxa"/><w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar></w:tcPr>
        ${lines.map((text, index) => paragraphXml(text, {
          size,
          before: index === 0 ? 0 : 16,
          after: 8,
          line: 210
        })).join("")}
      </w:tc>
    </w:tr>`;

  return blankParagraphXml({ size, line: 180 })
    + horizontalRuleXml()
    + blankParagraphXml({ size, line: 180 })
    + tableXml(rowXml, 1, tableWidth, { width: tableWidth, before: 0, after: 0 });
}

function pricePackageBlockXml(lines, options = {}) {
  if (!lines.length) return "";

  const tableWidth = options.width || 9000;
  const size = options.size || 24;
  const rowXml = `
    <w:tr>
      <w:tc>
        <w:tcPr><w:tcW w:w="${tableWidth}" w:type="dxa"/><w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar></w:tcPr>
        ${lines.map((text, index) => {
          const value = String(text || "").trim();
          const isFirstLine = index === 0;
          const startsSecondPriceOption = /^Prijs inclusief zekerhedenpakket/i.test(value);
          const isPrice = /^(Als-is prijs|Prijs inclusief zekerhedenpakket)/i.test(value);
          const isPackageBullet = /^(3 maanden technische garantie|een volledig jaar APK|was en poetsbeurt|door de fabrikant|de tenaamstelling|oplossen inspectiepunten|6 of 12 maanden garantie)/i.test(value);
          const before = isFirstLine || startsSecondPriceOption ? 0 : 10;
          const after = isPrice ? 18 : 8;
          const paragraph = paragraphXml(text, {
            size,
            bold: isPrice,
            bullet: isPackageBullet,
            color: isPrice ? "060250" : "",
            before,
            after,
            line: 230
          });

          if (!startsSecondPriceOption) return paragraph;
          return blankParagraphXml({ size, line: 230 }) + paragraph;
        }).join("")}
      </w:tc>
    </w:tr>`;

  return tableXml(rowXml, 1, tableWidth, { width: tableWidth, before: 0, after: 0 });
}

function keyValueColumnsXml(pairs, options = {}) {
  const columns = options.columns || 2;
  const tableWidth = options.width || 9000;
  const cellWidth = Math.floor(tableWidth / columns);
  const rows = chunkArray(pairs, columns).map((row) => `
    <w:tr>
      ${Array.from({ length: columns }).map((_, index) => {
        const pair = row[index];
        return `<w:tc>
          <w:tcPr><w:tcW w:w="${cellWidth}" w:type="dxa"/><w:tcMar><w:top w:w="20" w:type="dxa"/><w:left w:w="60" w:type="dxa"/><w:bottom w:w="20" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar></w:tcPr>
          ${pair ? paragraphXml(`${pair[0]}: ${pair[1]}`, { size: options.size || 18, after: 0, line: 205 }) : paragraphXml("", { size: options.size || 18, after: 0, line: 205 })}
        </w:tc>`;
      }).join("")}
    </w:tr>`).join("");

  return tableXml(rows, columns, cellWidth, { width: tableWidth, before: options.before || 0, after: 60 });
}

function sectionColumnsXml(sections, options = {}) {
  const columns = options.columns || 3;
  const tableWidth = options.width || 9000;
  const cellWidth = Math.floor(tableWidth / columns);
  const rows = chunkArray(sections, columns).map((row) => `
    <w:tr>
      ${Array.from({ length: columns }).map((_, index) => {
        const section = row[index];
        return `<w:tc>
          <w:tcPr><w:tcW w:w="${cellWidth}" w:type="dxa"/><w:tcMar><w:top w:w="40" w:type="dxa"/><w:left w:w="60" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="160" w:type="dxa"/></w:tcMar></w:tcPr>
          ${section ? [
            paragraphXml(section.heading, { size: (options.size || 18) + 2, bold: true, after: 18, line: 205 }),
            ...section.items.map((item) => paragraphXml(item, { size: options.size || 18, bullet: true, after: 0, line: 200 }))
          ].join("") : paragraphXml("", { size: options.size || 18, after: 0, line: 200 })}
        </w:tc>`;
      }).join("")}
    </w:tr>`).join("");

  return tableXml(rows, columns, cellWidth, { width: tableWidth, before: 28, after: 65 });
}

function tableXml(rowsXml, columns, cellWidth, options = {}) {
  const tableWidth = options.width || (cellWidth * columns);
  return `
    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="${tableWidth}" w:type="dxa"/>
        <w:tblInd w:w="0" w:type="dxa"/>
        <w:jc w:val="center"/>
        <w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>
        <w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>
        <w:tblpPr/>
      </w:tblPr>
      <w:tblGrid>${Array.from({ length: columns }).map(() => `<w:gridCol w:w="${cellWidth}"/>`).join("")}</w:tblGrid>
      <w:tr><w:tc><w:tcPr><w:gridSpan w:val="${columns}"/><w:tcW w:w="${tableWidth}" w:type="dxa"/></w:tcPr>${paragraphXml("", { before: options.before || 0, after: 0, line: 1 })}</w:tc></w:tr>
      ${rowsXml}
      <w:tr><w:tc><w:tcPr><w:gridSpan w:val="${columns}"/><w:tcW w:w="${tableWidth}" w:type="dxa"/></w:tcPr>${paragraphXml("", { before: 0, after: options.after || 0, line: 1 })}</w:tc></w:tr>
    </w:tbl>`;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function documentXml(bodyXml) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" xmlns:cx1="http://schemas.microsoft.com/office/drawing/2015/9/8/chartex" xmlns:cx2="http://schemas.microsoft.com/office/drawing/2015/10/21/chartex" xmlns:cx3="http://schemas.microsoft.com/office/drawing/2016/5/9/chartex" xmlns:cx4="http://schemas.microsoft.com/office/drawing/2016/5/10/chartex" xmlns:cx5="http://schemas.microsoft.com/office/drawing/2016/5/11/chartex" xmlns:cx6="http://schemas.microsoft.com/office/drawing/2016/5/12/chartex" xmlns:cx7="http://schemas.microsoft.com/office/drawing/2016/5/13/chartex" xmlns:cx8="http://schemas.microsoft.com/office/drawing/2016/5/14/chartex" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:aink="http://schemas.microsoft.com/office/drawing/2016/ink" xmlns:am3d="http://schemas.microsoft.com/office/drawing/2017/model3d" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid" xmlns:w16="http://schemas.microsoft.com/office/word/2018/wordml" xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du" xmlns:w16sdtdh="http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash" xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex" xmlns:sl="http://schemas.openxmlformats.org/schemaLibrary/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" mc:Ignorable="w14 w15 w16se w16cid w16 w16cex w16sdtdh w16du wp14"><w:body>${bodyXml}</w:body></w:document>`;
}

function imageDrawingXml(relId, cx, cy) {
  return `
    <w:p>
      <w:pPr><w:spacing w:before="0" w:after="90"/><w:jc w:val="center"/></w:pPr>
      <w:r>
        <w:drawing>
          <wp:inline distT="0" distB="0" distL="0" distR="0">
            <wp:extent cx="${cx}" cy="${cy}"/>
            <wp:effectExtent l="0" t="0" r="0" b="0"/>
            <wp:docPr id="1" name="Showroomfoto"/>
            <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
            <a:graphic>
              <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:pic>
                  <pic:nvPicPr><pic:cNvPr id="0" name="Showroomfoto"/><pic:cNvPicPr/></pic:nvPicPr>
                  <pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
                  <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>`;
}

function fitImageSize(buffer, maxCx, maxCy) {
  const dimensions = imageDimensions(buffer);
  if (!dimensions) return { cx: maxCx, cy: Math.min(maxCy, Math.round(maxCx * 0.55)) };

  const ratio = dimensions.width / dimensions.height;
  let cx = maxCx;
  let cy = Math.round(cx / ratio);
  if (cy > maxCy) {
    cy = maxCy;
    cx = Math.round(cy * ratio);
  }
  return { cx, cy };
}

function fixedImageWidth(buffer, cx) {
  const dimensions = imageDimensions(buffer);
  if (!dimensions) return { cx, cy: Math.round(cx * 0.55) };

  return {
    cx,
    cy: Math.round(cx * (dimensions.height / dimensions.width))
  };
}

function imageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;

  if (buffer.readUInt32BE(0) === 0x89504e47 && buffer.toString("ascii", 12, 16) === "IHDR") {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 9) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) return null;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7)
        };
      }
      offset += 2 + length;
    }
  }

  return null;
}

function extractSectPr(documentXmlText) {
  return documentXmlText.match(/<w:sectPr[\s\S]*<\/w:sectPr>/)?.[0] || "";
}

function showroomSectPr(sectPr) {
  const topMargin = 2550;
  const bottomMargin = 1050;
  const marginMatch = String(sectPr || "").match(/<w:pgMar\b[^>]*\/>/);
  if (!marginMatch) {
    return String(sectPr || "").replace("</w:sectPr>", `<w:pgMar w:top="${topMargin}" w:right="1417" w:bottom="${bottomMargin}" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`);
  }

  const nextMargin = marginMatch[0]
    .replace(/\sw:top="[^"]*"/, ` w:top="${topMargin}"`)
    .replace(/\sw:bottom="[^"]*"/, ` w:bottom="${bottomMargin}"`);
  return String(sectPr || "").replace(marginMatch[0], nextMargin);
}

function replaceDocumentBodyContent(originalDocumentXml, bodyXml) {
  const xml = String(originalDocumentXml || "");
  const bodyMatch = xml.match(/<w:body>([\s\S]*)<\/w:body>/);
  if (!bodyMatch) return documentXml(bodyXml);

  return xml.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${bodyXml}</w:body>`);
}

function ensureDrawingNamespaces(documentXmlText) {
  const requiredNamespaces = [
    ["a", "http://schemas.openxmlformats.org/drawingml/2006/main"],
    ["pic", "http://schemas.openxmlformats.org/drawingml/2006/picture"],
    ["wp", "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"]
  ];

  return requiredNamespaces.reduce((xml, [prefix, uri]) => {
    if (xml.includes(`xmlns:${prefix}=`)) return xml;
    return xml.replace(/<w:document\b/, `<w:document xmlns:${prefix}="${uri}"`);
  }, String(documentXmlText || ""));
}

function defaultSectPr() {
  return `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="2300" w:right="900" w:bottom="1300" w:left="900" w:header="450" w:footer="450" w:gutter="0"/></w:sectPr>`;
}

function defaultDocumentRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
}

function addRelationship(xml, id, target) {
  if (xml.includes(`Id="${id}"`)) return xml;
  const relationship = `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`;
  return xml.replace("</Relationships>", `${relationship}</Relationships>`);
}

function nextRelationshipId(xml) {
  const ids = [...String(xml || "").matchAll(/Id="rId(\d+)"/g)].map((match) => Number(match[1]));
  return `rId${Math.max(0, ...ids) + 1}`;
}

function defaultContentTypes() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
}

function addImageContentType(xml, ext, contentType) {
  const extension = ext.replace(".", "");
  if (xml.includes(`Extension="${extension}"`)) return xml;
  return xml.replace("</Types>", `<Default Extension="${extension}" ContentType="${contentType || "image/jpeg"}"/></Types>`);
}

function imageExtension(contentType) {
  if (/png/i.test(contentType || "")) return ".png";
  if (/webp/i.test(contentType || "")) return ".webp";
  return ".jpg";
}

function createEmptyDocxEntries() {
  const entries = new Map();
  entries.set("[Content_Types].xml", { data: Buffer.from(defaultContentTypes()), method: 0 });
  entries.set("_rels/.rels", {
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    method: 0
  });
  entries.set("word/_rels/document.xml.rels", { data: Buffer.from(defaultDocumentRels()), method: 0 });
  entries.set("word/document.xml", { data: Buffer.from(documentXml(defaultSectPr())), method: 0 });
  return entries;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readZipEntries(buffer) {
  const entries = new Map();
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;

  while (offset < end) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressedData = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const data = method === 8 ? require("zlib").inflateRawSync(compressedData) : Buffer.from(compressedData);

    if (data.length === uncompressedSize) {
      entries.set(name, { data, method: 0 });
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("Ongeldig Word-template");
}

function writeZipEntries(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, entry] of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || "");
    const fileName = Buffer.from(name);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, fileName, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, fileName);

    offset += local.length + fileName.length + data.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.size, 8);
  eocd.writeUInt16LE(entries.size, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, eocd]);
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

      syncInventoryFromMobilox().catch((error) => {
        console.error("Mobilox voorraad sync na login mislukt:", error.message);
      });

      sendJson(response, 200, { ok: true }, {
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

  if (request.method === "POST" && url.pathname === "/api/showroomkaart") {
    if (!requireSession(request, response)) return;

    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const result = await createShowroomCardDocx({
        licensePlate: payload.licensePlate,
        vehicleId: payload.vehicleId
      });

      response.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(result.fileName)}"`,
        "Cache-Control": "no-store"
      });
      response.end(result.buffer);
    } catch (error) {
      sendJson(response, error.status || 500, {
        ok: false,
        code: error.code || "",
        message: error.message || "Showroomkaart kon niet worden gemaakt"
      });
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

  const protectedPages = ["/dashboard", "/dashboard.html", "/camper-detail", "/camper-detail.html", "/todos", "/todos.html", "/new-camper", "/new-camper.html", "/op-het-oog", "/op-het-oog.html", "/photos", "/photos.html", "/showroomkaart", "/showroomkaart.html"];
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

if (require.main === module) {
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
}

module.exports = {
  buildShowroomDocx,
  fetchMobiloxPreview,
  parseMobiloxDetail,
  normalizeLicensePlateKey,
  normalizeShowroomText,
  readZipEntries
};
