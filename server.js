const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const USERNAME = process.env.SITE_USERNAME || "bram";
const PASSWORD = process.env.SITE_PASSWORD || "1234";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret-on-render";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const VEHICLES_FILE = path.join(DATA_DIR, "vehicles.json");
const SESSION_MAX_AGE = 1000 * 60 * 60 * 8;

const sessions = new Map();

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
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
      if (body.length > 1_000_000) {
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

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(VEHICLES_FILE)) {
    fs.writeFileSync(VEHICLES_FILE, "[]\n", "utf8");
  }
}

function readVehicles() {
  ensureDataFile();
  const content = fs.readFileSync(VEHICLES_FILE, "utf8");
  return JSON.parse(content || "[]");
}

function writeVehicles(vehicles) {
  ensureDataFile();
  fs.writeFileSync(VEHICLES_FILE, `${JSON.stringify(vehicles, null, 2)}\n`, "utf8");
}

function cleanVehicle(input) {
  return {
    title: String(input.title || "").trim(),
    brand: String(input.brand || "").trim(),
    model: String(input.model || "").trim(),
    year: String(input.year || "").trim(),
    mileage: String(input.mileage || "").trim(),
    price: String(input.price || "").trim(),
    status: String(input.status || "Te koop").trim(),
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
    const vehicles = readVehicles();
    sendJson(response, 200, { vehicles });
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

      const vehicles = readVehicles();
      const newVehicle = {
        id: crypto.randomUUID(),
        ...vehicle
      };
      vehicles.unshift(newVehicle);
      writeVehicles(vehicles);
      sendJson(response, 201, { ok: true, vehicle: newVehicle });
    } catch (error) {
      sendJson(response, 400, { ok: false, message: "Voertuig kon niet worden opgeslagen" });
    }
    return;
  }

  if (request.method === "PUT" && vehicleMatch) {
    if (!requireSession(request, response)) return;

    try {
      const body = await readBody(request);
      const updates = cleanVehicle(JSON.parse(body || "{}"));
      const vehicles = readVehicles();
      const index = vehicles.findIndex((vehicle) => vehicle.id === vehicleMatch[1]);

      if (index === -1) {
        sendJson(response, 404, { ok: false, message: "Voertuig niet gevonden" });
        return;
      }

      vehicles[index] = {
        ...vehicles[index],
        ...updates
      };
      writeVehicles(vehicles);
      sendJson(response, 200, { ok: true, vehicle: vehicles[index] });
    } catch (error) {
      sendJson(response, 400, { ok: false, message: "Voertuig kon niet worden bijgewerkt" });
    }
    return;
  }

  if (request.method === "DELETE" && vehicleMatch) {
    if (!requireSession(request, response)) return;

    const vehicles = readVehicles();
    const nextVehicles = vehicles.filter((vehicle) => vehicle.id !== vehicleMatch[1]);

    if (nextVehicles.length === vehicles.length) {
      sendJson(response, 404, { ok: false, message: "Voertuig niet gevonden" });
      return;
    }

    writeVehicles(nextVehicles);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method !== "GET") {
    response.writeHead(405);
    response.end("Methode niet toegestaan");
    return;
  }

  if ((url.pathname === "/dashboard" || url.pathname === "/dashboard.html") && !getSession(request)) {
    response.writeHead(302, { Location: "/login.html" });
    response.end();
    return;
  }

  const routeAliases = {
    "/dashboard": "/dashboard.html",
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

server.listen(PORT, () => {
  console.log(`ZeelandCamper draait op http://localhost:${PORT}`);
});
