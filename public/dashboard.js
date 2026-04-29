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

  const form = document.querySelector("#vehicle-form");
  const list = document.querySelector("#vehicle-list");
  const count = document.querySelector("#vehicle-count");
  const message = document.querySelector("#vehicle-message");
  const formTitle = document.querySelector("#form-title");
  const resetButton = document.querySelector("#reset-form");
  let vehicles = [];

  await loadVehicles();

  resetButton.addEventListener("click", () => resetForm());

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";

    const formData = new FormData(form);
    const id = formData.get("id");
    const payload = Object.fromEntries(formData.entries());
    delete payload.id;

    const response = await fetch(id ? `/api/vehicles/${encodeURIComponent(id)}` : "/api/vehicles", {
      method: id ? "PUT" : "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      message.textContent = result.message || "Opslaan mislukt";
      return;
    }

    message.textContent = "Opgeslagen";
    resetForm();
    await loadVehicles();
  });

  async function loadVehicles() {
    const response = await fetch("/api/vehicles");
    const data = await response.json();
    vehicles = data.vehicles || [];
    count.textContent = vehicles.length;
    renderVehicles();
  }

  function renderVehicles() {
    if (!vehicles.length) {
      list.innerHTML = `<p class="empty-state">Nog geen voertuigen in de database.</p>`;
      return;
    }

    list.innerHTML = vehicles.map((vehicle) => `
      <article class="vehicle-row">
        <div>
          <p class="vehicle-status">${escapeHtml(vehicle.status)}</p>
          <h3>${escapeHtml(vehicle.title)}</h3>
          <p>${escapeHtml(vehicle.brand)} ${escapeHtml(vehicle.model)}${vehicle.year ? ` · ${escapeHtml(vehicle.year)}` : ""}</p>
          <p>${formatMileage(vehicle.mileage)}${vehicle.price ? ` · ${formatPrice(vehicle.price)}` : ""}</p>
        </div>
        <div class="row-actions">
          <button class="secondary-button small-button" type="button" data-edit="${escapeHtml(vehicle.id)}">Bewerken</button>
          <button class="danger-button small-button" type="button" data-delete="${escapeHtml(vehicle.id)}">Verwijderen</button>
        </div>
      </article>
    `).join("");

    list.querySelectorAll("[data-edit]").forEach((button) => {
      button.addEventListener("click", () => editVehicle(button.dataset.edit));
    });

    list.querySelectorAll("[data-delete]").forEach((button) => {
      button.addEventListener("click", () => deleteVehicle(button.dataset.delete));
    });
  }

  function editVehicle(id) {
    const vehicle = vehicles.find((item) => item.id === id);
    if (!vehicle) return;

    formTitle.textContent = "Voertuig bewerken";
    Object.entries(vehicle).forEach(([key, value]) => {
      if (form.elements[key]) {
        form.elements[key].value = value || "";
      }
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function deleteVehicle(id) {
    const vehicle = vehicles.find((item) => item.id === id);
    if (!vehicle || !confirm(`${vehicle.title} verwijderen?`)) return;

    const response = await fetch(`/api/vehicles/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });

    if (response.ok) {
      await loadVehicles();
      resetForm();
    }
  }

  function resetForm() {
    form.reset();
    form.elements.id.value = "";
    formTitle.textContent = "Voertuig toevoegen";
    message.textContent = "";
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
