const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const USERNAME = process.env.SITE_USERNAME || "bram";
const PASSWORD = process.env.SITE_PASSWORD || "1234";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret-on-render";
const PUBLIC_DIR = path.join(__dirname, "public");
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

  if (request.method !== "GET") {
    response.writeHead(405);
    response.end("Methode niet toegestaan");
    return;
  }

  if (url.pathname === "/dashboard" && !getSession(request)) {
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
