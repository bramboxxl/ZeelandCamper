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
  let vehicles = data.vehicles || [];

  count.textContent = vehicles.length;

  if (!vehicles.length) {
    list.innerHTML = `<p class="empty-state">Nog geen campers in de database.</p>`;
    firstDetailLink.setAttribute("aria-disabled", "true");
    return;
  }

  firstDetailLink.href = `/camper-detail.html?id=${encodeURIComponent(vehicles[0].id)}`;
  renderVehicles();

  list.addEventListener("change", async (event) => {
    const select = event.target.closest(".status-select");
    if (!select) return;

    const card = select.closest(".overview-card");
    const vehicle = vehicles.find((item) => item.id === card.dataset.vehicleId);
    if (!vehicle) return;

    const previousStatus = vehicle.status;
    vehicle.status = select.value;
    select.disabled = true;

    try {
      const response = await fetch(`/api/vehicles/${encodeURIComponent(vehicle.id)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(vehicle)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Status opslaan mislukt");
      vehicle.status = result.vehicle.status;
    } catch (error) {
      vehicle.status = previousStatus;
      select.value = previousStatus || "Op het oog";
      window.alert(error.message || "Status opslaan mislukt");
    } finally {
      select.disabled = false;
    }
  });

  function renderVehicles() {
    list.innerHTML = vehicles.map((vehicle, index) => `
      <article class="overview-card" data-vehicle-id="${escapeHtml(vehicle.id)}">
        <a class="overview-card-link" href="/camper-detail.html?id=${encodeURIComponent(vehicle.id)}">
          <span class="vehicle-status">${escapeHtml(vehicle.sourceId || vehicle.id)}</span>
          <h3>${escapeHtml(vehicle.title || "Camper")}</h3>
          <p>${escapeHtml(vehicle.licensePlate)}${vehicle.year ? ` - ${escapeHtml(vehicle.year)}` : ""}</p>
          <p>${formatMileage(vehicle.mileage)}${vehicle.price ? ` - ${formatPrice(vehicle.price)}` : ""}</p>
          <p>${escapeHtml(vehicle.notes || vehicle.additionalInfo || vehicle.description || "Geen opmerking")}</p>
          <small>Camper ${index + 1} van ${vehicles.length}</small>
        </a>
        <label class="status-control">
          Status
          <select class="status-select">
            ${statusOptions(vehicle.status)}
          </select>
        </label>
      </article>
    `).join("");
  }
})();

function statusOptions(currentStatus) {
  return ["Op het oog", "intake en contract", "staat te koop", "verkocht", "gaat niet door"]
    .map((status) => `<option value="${escapeHtml(status)}"${status === currentStatus ? " selected" : ""}>${escapeHtml(status)}</option>`)
    .join("");
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
