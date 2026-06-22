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

  const params = new URLSearchParams(window.location.search);
  const vehicleId = params.get("id") || "";
  const licensePlate = normalizeLicensePlate(params.get("kenteken"));
  const status = document.querySelector("#zeelandnet-status");
  const content = document.querySelector("#draft-content");
  const detailLink = document.querySelector("#detail-link");
  const photoCount = document.querySelector("#photo-count");

  if (vehicleId) detailLink.href = `/camper-detail.html?id=${encodeURIComponent(vehicleId)}`;

  try {
    const response = await fetch("/api/zeelandnet/draft", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ vehicleId, licensePlate })
    });
    const draft = await response.json();

    if (!response.ok) throw new Error(draft.message || "Zeelandnet concept kon niet worden gemaakt");

    status.textContent = "Controleer de velden, plaats ze in Zeelandnet en doe de laatste stap/betaling handmatig.";
    photoCount.textContent = String(draft.photos.length);
    content.innerHTML = renderDraft(draft);
  } catch (error) {
    status.textContent = error.message || "Zeelandnet concept kon niet worden gemaakt";
    content.innerHTML = `<p class="empty-state">${escapeHtml(status.textContent)}</p>`;
  }

  content.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy]");
    const targetButton = event.target.closest("[data-copy-target]");
    if (!button && !targetButton) return;

    const copyButton = button || targetButton;
    const copyValue = targetButton
      ? document.querySelector(targetButton.dataset.copyTarget)?.value || ""
      : button.dataset.copy || "";

    await navigator.clipboard.writeText(copyValue);
    const originalText = copyButton.textContent;
    copyButton.textContent = "Gekopieerd";
    setTimeout(() => {
      copyButton.textContent = originalText;
    }, 1200);
  });
})();

function renderDraft(draft) {
  const fields = [
    ["Groep", draft.category.group],
    ["Subgroep", draft.category.subgroup],
    ["Titel", draft.title],
    ["Type", draft.type],
    ["Conditie", draft.condition],
    ["Prijstype", draft.priceType],
    ["Prijs", draft.price],
    ["Bieden toestaan", draft.allowBids ? "Ja" : "Nee"],
    ["Website toevoegen", draft.websiteUrl],
    ["Plaats", draft.address.place],
    ["Buiten zeeland", draft.address.outsideZeeland ? "Ja" : "Nee"],
    ["Toon verkoopadres", draft.address.showSalesAddress ? "Ja" : "Nee"],
    ["Straat", draft.address.street],
    ["Huisnr.", draft.address.houseNumber],
    ["Camper type", draft.camper.type],
    ["Merk", draft.camper.brand],
    ["Model", draft.camper.model],
    ["Aantal slaapplaatsen", draft.camper.sleepingPlaces],
    ["Brandstof", draft.camper.fuel]
  ];

  return `
    <div class="zeelandnet-fields">
      ${fields.map(([label, value]) => fieldCard(label, value)).join("")}
    </div>
    <section class="zeelandnet-text">
      <div class="zeelandnet-section-header">
        <h3>Advertentietekst</h3>
        <button class="secondary-button small-button" type="button" data-copy-target="#advert-text">Kopieer tekst</button>
      </div>
      <textarea id="advert-text" readonly>${escapeHtml(draft.text)}</textarea>
    </section>
    <section class="zeelandnet-photos">
      <div class="zeelandnet-section-header">
        <h3>Foto's uit Mobilox</h3>
        <a class="secondary-button small-button" href="${escapeHtmlAttr(draft.zeelandnetUrl)}" target="_blank" rel="noreferrer">Open Zeelandnet</a>
      </div>
      <div class="zeelandnet-photo-grid">
        ${draft.photos.map((url, index) => `
          <a class="zeelandnet-photo" href="${escapeHtmlAttr(url)}" target="_blank" rel="noreferrer">
            <img src="${escapeHtmlAttr(url)}" alt="Mobilox foto ${index + 1}">
            <span>Foto ${index + 1}</span>
          </a>
        `).join("") || `<p class="empty-state">Geen Mobilox foto's gevonden.</p>`}
      </div>
    </section>
  `;
}

function fieldCard(label, value) {
  const text = String(value || "-");
  return `
    <div class="zeelandnet-field">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(text)}</strong>
      <button class="secondary-button small-button" type="button" data-copy="${escapeHtmlAttr(text)}">Kopieer</button>
    </div>
  `;
}

function normalizeLicensePlate(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeHtmlAttr(value) {
  return escapeHtml(value).replaceAll("\n", "&#10;");
}
