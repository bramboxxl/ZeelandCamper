(async () => {
  const sessionResponse = await fetch("/api/session");
  const session = await sessionResponse.json();

  if (!session.authenticated) {
    window.location.href = "/login.html";
    return;
  }

  document.querySelector("#logout-button").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/";
  });

  const form = document.querySelector("#vehicle-form");
  const message = document.querySelector("#vehicle-message");
  const formTitle = document.querySelector("#form-title");
  const pageTitle = document.querySelector("#page-title");
  const pageSubtitle = document.querySelector("#page-subtitle");
  const positionLabel = document.querySelector("#position-label");
  const previousLink = document.querySelector("#previous-vehicle");
  const nextLink = document.querySelector("#next-vehicle");
  const params = new URLSearchParams(window.location.search);
  const requestedId = params.get("id");

  const vehiclesResponse = await fetch("/api/vehicles");
  const data = await vehiclesResponse.json();
  const vehicles = data.vehicles || [];

  if (!vehicles.length) {
    pageTitle.textContent = "Geen campers";
    pageSubtitle.textContent = "Er staan nog geen campers in de database.";
    form.innerHTML = `<p class="empty-state">Ga terug naar het overzicht om later opnieuw te proberen.</p>`;
    return;
  }

  const selectedIndex = Math.max(0, vehicles.findIndex((vehicle) => vehicle.id === requestedId));
  const vehicle = vehicles[selectedIndex];
  const previousVehicle = vehicles[(selectedIndex - 1 + vehicles.length) % vehicles.length];
  const nextVehicle = vehicles[(selectedIndex + 1) % vehicles.length];

  previousLink.href = `/camper-detail.html?id=${encodeURIComponent(previousVehicle.id)}`;
  nextLink.href = `/camper-detail.html?id=${encodeURIComponent(nextVehicle.id)}`;
  positionLabel.textContent = `${selectedIndex + 1} / ${vehicles.length}`;
  pageTitle.textContent = vehicle.sourceId || vehicle.id;
  pageSubtitle.textContent = vehicle.title || "Camperdetails";
  formTitle.textContent = `${vehicle.sourceId || vehicle.id} · ${vehicle.title || "Camper"}`;

  Object.entries(vehicle).forEach(([key, value]) => {
    if (form.elements[key]) {
      form.elements[key].value = value || "";
    }
  });

  if (form.elements.status) {
    form.elements.status.value = vehicle.status || vehicle.notes || "Te koop";
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";

    const formData = new FormData(form);
    const id = formData.get("id");
    const payload = Object.fromEntries(formData.entries());
    delete payload.id;
    payload.status = payload.notes || "Te koop";

    const response = await fetch(`/api/vehicles/${encodeURIComponent(id)}`, {
      method: "PUT",
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
    pageSubtitle.textContent = result.vehicle.title || "Camperdetails";
    formTitle.textContent = `${result.vehicle.sourceId || result.vehicle.id} · ${result.vehicle.title || "Camper"}`;
  });
})();
