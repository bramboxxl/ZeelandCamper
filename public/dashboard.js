(async () => {
  const response = await fetch("/api/session");
  const session = await response.json();

  if (!session.authenticated) {
    window.location.href = "/login.html";
    return;
  }

  document.querySelector("#logout-button").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/";
  });

  const list = document.querySelector("#vehicle-list");
  const count = document.querySelector("#vehicle-count");
  const firstDetailLink = document.querySelector("#first-detail-link");

  const vehiclesResponse = await fetch("/api/vehicles");
  const data = await vehiclesResponse.json();
  const vehicles = data.vehicles || [];

  count.textContent = vehicles.length;

  if (!vehicles.length) {
    list.innerHTML = `<p class="empty-state">Nog geen campers in de database.</p>`;
    firstDetailLink.setAttribute("aria-disabled", "true");
    return;
  }

  firstDetailLink.href = `/camper-detail.html?id=${encodeURIComponent(vehicles[0].id)}`;
  list.innerHTML = vehicles.map((vehicle, index) => `
    <a class="overview-card" href="/camper-detail.html?id=${encodeURIComponent(vehicle.id)}">
      <span class="vehicle-status">${escapeHtml(vehicle.sourceId || vehicle.id)}</span>
      <h3>${escapeHtml(vehicle.title || "Camper")}</h3>
      <p>${escapeHtml(vehicle.licensePlate)}${vehicle.year ? ` - ${escapeHtml(vehicle.year)}` : ""}</p>
      <p>${formatMileage(vehicle.mileage)}${vehicle.price ? ` - ${formatPrice(vehicle.price)}` : ""}</p>
      <p>${escapeHtml(vehicle.notes || vehicle.additionalInfo || vehicle.description || "Geen opmerking")}</p>
      <small>Camper ${index + 1} van ${vehicles.length}</small>
    </a>
  `).join("");
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
