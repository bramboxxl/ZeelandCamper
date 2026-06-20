let mobiloxCredentials = null;

(async () => {
  const loginLink = document.querySelector(".nav-button[href='/login.html']");

  if (loginLink) {
    try {
      const response = await fetch("/api/session");
      const session = await response.json();

      if (session.authenticated) {
        loginLink.textContent = "Dashboard";
        loginLink.href = "/dashboard";
      }
    } catch {
      loginLink.textContent = "Login";
    }
  }

  const grid = document.querySelector("#vehicle-grid");
  if (!grid) return;

  try {
    const response = await fetch("/api/vehicles");
    const data = await response.json();
    const vehicles = (data.vehicles || []).filter((vehicle) => (vehicle.status || "staat te koop") === "staat te koop");

    if (!vehicles.length) {
      grid.innerHTML = `
        <article class="camper-card">
          <div class="camper-image camper-image-1"></div>
          <div>
            <p class="card-kicker">Binnenkort online</p>
            <h3>Nieuwe campers volgen</h3>
            <p>Er staan op dit moment nog geen voertuigen online.</p>
          </div>
        </article>
      `;
      return;
    }

    grid.innerHTML = vehicles.map((vehicle, index) => {
      const photo = firstVehiclePhoto(vehicle);
      const licensePlate = normalizeLicensePlate(vehicle.licensePlate);

      return `
        <article class="camper-card showroom-select-card" data-vehicle-id="${escapeHtml(vehicle.id || "")}" data-license-plate="${escapeHtml(licensePlate)}">
          ${photo
            ? `<img class="vehicle-photo" src="${escapeHtml(photo)}" alt="${escapeHtml(vehicle.title)}">`
            : `<div class="camper-image camper-image-${(index % 3) + 1}"></div>`}
          <div>
            <p class="card-kicker">${escapeHtml(vehicle.sourceId || vehicle.licensePlate || "Camper")}</p>
            <h3>${escapeHtml(vehicle.title)}</h3>
            <p>${vehicle.licensePlate ? `${escapeHtml(vehicle.licensePlate)} - ` : ""}${vehicle.year ? `${escapeHtml(vehicle.year)} - ` : ""}${escapeHtml(vehicle.color)}</p>
            <p>${formatMileage(vehicle.mileage)}${vehicle.price ? ` - ${formatPrice(vehicle.price)}` : ""}</p>
            <p>${escapeHtml(vehicle.additionalInfo || vehicle.description || vehicle.notes || "Klik om een showroomkaart te maken.")}</p>
            <button class="primary-button small-button showroom-card-button" type="button">Genereer showroomkaart</button>
          </div>
        </article>
      `;
    }).join("");

    grid.addEventListener("click", (event) => {
      const button = event.target.closest(".showroom-card-button");
      if (!button) return;

      const card = button.closest(".showroom-select-card");
      if (!card) return;

      downloadShowroomCard({
        vehicleId: card.dataset.vehicleId || "",
        licensePlate: card.dataset.licensePlate || ""
      }, button);
    });
  } catch {
    grid.innerHTML = `
      <article class="camper-card">
        <div class="camper-image camper-image-1"></div>
        <div>
          <p class="card-kicker">Niet beschikbaar</p>
          <h3>Aanbod kon niet worden geladen</h3>
          <p>Probeer het later opnieuw.</p>
        </div>
      </article>
    `;
  }
})();

function firstVehiclePhoto(vehicle) {
  const photos = Array.isArray(vehicle.photos) ? vehicle.photos : [];
  const selected = photos.find((photo) => photo.selected) || photos[0];
  if (selected?.url) return selected.url;
  return vehicle.imageUrl || "";
}

function normalizeLicensePlate(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

async function downloadShowroomCard(payload, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Showroomkaart maken...";

  try {
    let response = await requestShowroomCard(payload);

    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      if (result.code === "missing_mobilox_credentials") {
        mobiloxCredentials = await askMobiloxCredentials();
        response = await requestShowroomCard(payload);
      }
    }

    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.message || "Showroomkaart maken mislukt");
    }

    const blob = await response.blob();
    const fileName = getDownloadFileName(response.headers.get("content-disposition")) || "showroomkaart.docx";
    const link = document.createElement("a");
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (error) {
    window.alert(error.message || "Showroomkaart maken mislukt");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function requestShowroomCard(payload) {
  return fetch("/api/showroomkaart", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      vehicleId: payload.vehicleId,
      licensePlate: normalizeLicensePlate(payload.licensePlate),
      mobiloxCredentials
    })
  });
}

function askMobiloxCredentials() {
  return new Promise((resolve, reject) => {
    const backdrop = document.createElement("div");
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.innerHTML = `
      <form style="position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:rgba(6,2,80,.45);padding:20px;">
        <div style="width:min(460px,100%);background:#fff;border-radius:8px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.25);">
          <h2 style="margin:0 0 10px;color:#060250;font-size:24px;">Mobilox inloggen</h2>
          <p style="margin:0 0 18px;line-height:1.45;">Vul de Mobilox inlog in om de Voorbeeld-tekst op te halen.</p>
          <label style="display:block;font-weight:700;margin-bottom:12px;">E-mail
            <input name="email" type="email" autocomplete="username" required style="display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:12px;border:1px solid #cfd8e3;border-radius:6px;font:inherit;">
          </label>
          <label style="display:block;font-weight:700;margin-bottom:18px;">Wachtwoord
            <input name="password" type="password" autocomplete="current-password" required style="display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:12px;border:1px solid #cfd8e3;border-radius:6px;font:inherit;">
          </label>
          <div style="display:flex;gap:10px;justify-content:flex-end;">
            <button type="button" data-cancel style="padding:12px 18px;border:1px solid #060250;border-radius:6px;background:#fff;color:#060250;font-weight:700;">Annuleren</button>
            <button type="submit" style="padding:12px 18px;border:1px solid #060250;border-radius:6px;background:#060250;color:#fff;font-weight:700;">Doorgaan</button>
          </div>
        </div>
      </form>
    `;
    const form = backdrop.querySelector("form");
    const email = form.elements.email;
    const password = form.elements.password;
    const close = () => backdrop.remove();

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const credentials = {
        email: email.value.trim(),
        password: password.value
      };
      close();
      resolve(credentials);
    });

    form.querySelector("[data-cancel]").addEventListener("click", () => {
      close();
      reject(new Error("Mobilox inloggen geannuleerd"));
    });

    document.body.appendChild(backdrop);
    email.focus();
  });
}

function getDownloadFileName(header) {
  const match = String(header || "").match(/filename="([^"]+)"/i);
  if (!match) return "";
  return decodeURIComponent(match[1]);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatPrice(value) {
  const number = Number(String(value).replace(/[^\d]/g, ""));
  if (!number) return "";
  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0
  }).format(number);
}

function formatMileage(value) {
  const number = Number(String(value).replace(/[^\d]/g, ""));
  if (!number) return "";
  return `${new Intl.NumberFormat("nl-NL").format(number)} km`;
}
