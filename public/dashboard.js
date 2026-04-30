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
  const overviewButton = document.querySelector("#show-overview");
  const previousButton = document.querySelector("#previous-vehicle");
  const nextButton = document.querySelector("#next-vehicle");
  let vehicles = [];
  let selectedIndex = -1;

  await loadVehicles();
  if (vehicles.length) selectVehicle(0);

  overviewButton.addEventListener("click", () => {
    document.querySelector(".vehicle-manager").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  previousButton.addEventListener("click", () => {
    if (!vehicles.length) return;
    selectVehicle((selectedIndex - 1 + vehicles.length) % vehicles.length);
  });

  nextButton.addEventListener("click", () => {
    if (!vehicles.length) return;
    selectVehicle((selectedIndex + 1) % vehicles.length);
  });

  resetButton.addEventListener("click", () => resetForm());

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";

    const formData = new FormData(form);
    const id = formData.get("id");
    const payload = Object.fromEntries(formData.entries());
    delete payload.id;
    payload.status = payload.notes || "Te koop";

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
    await loadVehicles();
    const index = vehicles.findIndex((vehicle) => vehicle.id === result.vehicle.id);
    selectVehicle(index === -1 ? 0 : index);
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
      list.innerHTML = `<p class="empty-state">Nog geen campers in de database.</p>`;
      return;
    }

    list.innerHTML = vehicles.map((vehicle, index) => `
      <button class="camper-list-button${index === selectedIndex ? " is-active" : ""}" type="button" data-index="${index}">
        <span>
          <strong>${escapeHtml(vehicle.sourceId || vehicle.id)}</strong>
          ${escapeHtml(vehicle.title)}
        </span>
        <small>${escapeHtml(vehicle.licensePlate)}${vehicle.price ? ` · ${formatPrice(vehicle.price)}` : ""}</small>
      </button>
    `).join("");

    list.querySelectorAll("[data-index]").forEach((button) => {
      button.addEventListener("click", () => selectVehicle(Number(button.dataset.index)));
    });
  }

  function selectVehicle(index) {
    if (index < 0 || index >= vehicles.length) return;

    selectedIndex = index;
    const vehicle = vehicles[index];
    formTitle.textContent = `${vehicle.sourceId || vehicle.id} · ${vehicle.title || "Camper"}`;

    Object.entries(vehicle).forEach(([key, value]) => {
      if (form.elements[key]) {
        form.elements[key].value = value || "";
      }
    });

    if (form.elements.status) {
      form.elements.status.value = vehicle.status || vehicle.notes || "Te koop";
    }

    message.textContent = "";
    renderVehicles();
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function resetForm() {
    form.reset();
    form.elements.id.value = "";
    formTitle.textContent = "Nieuwe camper";
    selectedIndex = -1;
    message.textContent = "";
    renderVehicles();
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
