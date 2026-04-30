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
    const vehicles = data.vehicles || [];

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

    grid.innerHTML = vehicles.map((vehicle, index) => `
      <article class="camper-card">
        ${vehicle.imageUrl
          ? `<img class="vehicle-photo" src="${escapeHtml(vehicle.imageUrl)}" alt="${escapeHtml(vehicle.title)}">`
          : `<div class="camper-image camper-image-${(index % 3) + 1}"></div>`}
        <div>
          <p class="card-kicker">${escapeHtml(vehicle.sourceId || vehicle.licensePlate || "Camper")}</p>
          <h3>${escapeHtml(vehicle.title)}</h3>
          <p>${vehicle.licensePlate ? `${escapeHtml(vehicle.licensePlate)} · ` : ""}${vehicle.year ? `${escapeHtml(vehicle.year)} · ` : ""}${escapeHtml(vehicle.color)}</p>
          <p>${formatMileage(vehicle.mileage)}${vehicle.price ? ` · ${formatPrice(vehicle.price)}` : ""}</p>
          <p>${escapeHtml(vehicle.additionalInfo || vehicle.description || vehicle.notes)}</p>
        </div>
      </article>
    `).join("");
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
