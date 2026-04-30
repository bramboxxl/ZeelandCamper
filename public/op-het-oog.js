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
  const vehiclesResponse = await fetch("/api/vehicles");
  const data = await vehiclesResponse.json();
  const vehicles = (data.vehicles || []).filter((vehicle) => (vehicle.status || "Op het oog") === "Op het oog");

  count.textContent = vehicles.length;

  if (!vehicles.length) {
    list.innerHTML = `<p class="empty-state">Geen campers met status Op het oog.</p>`;
    return;
  }

  list.innerHTML = vehicles.map((vehicle) => `
    <a class="overview-card" href="/camper-detail.html?id=${encodeURIComponent(vehicle.id)}">
      <span class="vehicle-status">${escapeHtml(vehicle.sourceId || vehicle.id)}</span>
      <h3>${escapeHtml(vehicle.title || "Camper")}</h3>
      <p>${escapeHtml(vehicle.licensePlate || "Geen kenteken")}</p>
      <p>${escapeHtml(vehicle.notes || vehicle.additionalInfo || "Geen opmerking")}</p>
      <small>Bekijk details</small>
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
