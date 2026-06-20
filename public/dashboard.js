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
  const firstShowroomkaartLink = document.querySelector("#first-showroomkaart-link");

  await fetch("/api/sync/inventory", { method: "POST" }).catch(() => {});

  const vehiclesResponse = await fetch("/api/vehicles");
  const data = await vehiclesResponse.json();
  let vehicles = data.vehicles || [];

  count.textContent = vehicles.length;

  if (!vehicles.length) {
    list.innerHTML = `<p class="empty-state">Nog geen campers in de database.</p>`;
    firstDetailLink.setAttribute("aria-disabled", "true");
    firstShowroomkaartLink.setAttribute("aria-disabled", "true");
    return;
  }

  firstDetailLink.href = `/camper-detail.html?id=${encodeURIComponent(vehicles[0].id)}`;
  firstShowroomkaartLink.href = "#";
  firstShowroomkaartLink.dataset.vehicleId = vehicles[0].id || "";
  firstShowroomkaartLink.dataset.licensePlate = normalizeLicensePlate(vehicles[0].licensePlate);
  renderVehicles();

  firstShowroomkaartLink.addEventListener("click", async (event) => {
    event.preventDefault();
    await downloadShowroomCard({
      vehicleId: firstShowroomkaartLink.dataset.vehicleId || "",
      licensePlate: firstShowroomkaartLink.dataset.licensePlate || ""
    }, firstShowroomkaartLink);
  });

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
          ${vehicle.imageUrl ? `<img class="overview-card-image" src="${escapeHtml(vehicle.imageUrl)}" alt="${escapeHtml(vehicle.title || "Camper")}">` : ""}
          <span class="vehicle-status">${escapeHtml(vehicle.sourceId || vehicle.id)}</span>
          <h3>${escapeHtml(vehicle.title || "Camper")}</h3>
          <p><strong>Kenteken:</strong> ${escapeHtml(vehicle.licensePlate || "-")}${vehicle.year ? ` - ${escapeHtml(vehicle.year)}` : ""}</p>
          <p>${formatMileage(vehicle.mileage)}${vehicle.price ? ` - ${formatPrice(vehicle.price)}` : ""}</p>
          <p>${escapeHtml(vehicle.notes || vehicle.additionalInfo || vehicle.description || "Geen opmerking")}</p>
          <small>Camper ${index + 1} van ${vehicles.length}</small>
        </a>
        <button class="secondary-button small-button overview-action showroomkaart-button" type="button" data-vehicle-id="${escapeHtml(vehicle.id || "")}" data-license-plate="${escapeHtml(normalizeLicensePlate(vehicle.licensePlate))}">Showroomkaart</button>
        <label class="status-control">
          Status
          <select class="status-select">
            ${statusOptions(vehicle.status)}
          </select>
        </label>
      </article>
    `).join("");
  }

  list.addEventListener("click", async (event) => {
    const button = event.target.closest(".showroomkaart-button");
    if (!button) return;

    await downloadShowroomCard({
      vehicleId: button.dataset.vehicleId || "",
      licensePlate: button.dataset.licensePlate || ""
    }, button);
  });
})();

function normalizeLicensePlate(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

async function downloadShowroomCard(payload, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Maken...";

  try {
    const response = await fetch("/api/showroomkaart", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        vehicleId: payload.vehicleId,
        licensePlate: normalizeLicensePlate(payload.licensePlate)
      })
    });

    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.message || "Showroomkaart maken mislukt");
    }

    const blob = await response.blob();
    const fileName = getDownloadFileName(response.headers.get("content-disposition")) || "showroomkaart.docx";
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
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

function getDownloadFileName(header) {
  const match = String(header || "").match(/filename="([^"]+)"/i);
  if (!match) return "";
  return decodeURIComponent(match[1]);
}

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
