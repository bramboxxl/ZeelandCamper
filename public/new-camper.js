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

  const form = document.querySelector("#new-vehicle-form");
  const message = document.querySelector("#vehicle-message");
  const rdwMessage = document.querySelector("#rdw-message");
  const rdwLookupButton = document.querySelector("#rdw-lookup-button");
  let rdwFinnikData = {};

  renderRdwFinnikData();

  rdwLookupButton.addEventListener("click", async () => {
    const licensePlate = form.elements.licensePlate.value.trim();
    rdwMessage.textContent = "";

    if (!licensePlate) {
      rdwMessage.textContent = "Vul eerst een kenteken in.";
      form.elements.licensePlate.focus();
      return;
    }

    rdwLookupButton.disabled = true;
    rdwMessage.textContent = "Data ophalen...";

    try {
      const response = await fetch(`/api/lookup/${encodeURIComponent(licensePlate)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Ophalen mislukt");

      rdwFinnikData = result.data || {};
      applyRdwDataToForm(rdwFinnikData);
      renderRdwFinnikData();
      rdwMessage.textContent = "Data opgehaald.";
    } catch (error) {
      rdwMessage.textContent = error.message || "Ophalen mislukt";
    } finally {
      rdwLookupButton.disabled = false;
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";

    const payload = Object.fromEntries(new FormData(form).entries());
    payload.todos = [];
    payload.photos = [];
    payload.rdwFinnikData = rdwFinnikData;

    const response = await fetch("/api/vehicles", {
      method: "POST",
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

    window.location.href = `/camper-detail.html?id=${encodeURIComponent(result.vehicle.id)}`;
  });

  function renderRdwFinnikData() {
    document.querySelector("#rdw-dimensions").textContent = formatDimensions(rdwFinnikData);
    document.querySelector("#rdw-seats").textContent = rdwFinnikData.seats || "-";
    document.querySelector("#finnik-owners").textContent = rdwFinnikData.ownerCount || "Niet beschikbaar";
    document.querySelector("#rdw-grid").innerHTML = rdwRows(rdwFinnikData).map(([label, value]) => `
      <div>
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value || "-")}</strong>
      </div>
    `).join("");
  }

  function applyRdwDataToForm(data) {
    if (data.make) form.elements.brand.value = data.make;
    if (data.tradeName) form.elements.model.value = data.tradeName;
    if (data.tradeName) form.elements.title.value = `${data.make} ${data.tradeName}`.trim();
  }
})();

function rdwRows(data) {
  return [
    ["Kenteken", data.licensePlate],
    ["Merk", data.make],
    ["Handelsbenaming", data.tradeName],
    ["Voertuigsoort", data.vehicleType],
    ["Brandstof", data.fuelType],
    ["Afmetingen", formatDimensions(data)],
    ["Zitplaatsen", data.seats],
    ["Aantal eigenaren", data.ownerCount || "Niet beschikbaar"],
    ["Gemiddelde landelijke wegenbelasting", data.roadTaxNationalAverage],
    ["Wegenbelasting Zeeland", data.roadTaxZeeland],
    ["Finnik status", data.finnikStatus]
  ];
}

function formatDimensions(data) {
  const length = data.length ? `${data.length} cm` : "";
  const width = data.width ? `${data.width} cm` : "";
  const height = data.height ? `${data.height} cm` : "";
  return [length, width, height].filter(Boolean).join(" x ") || "-";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
