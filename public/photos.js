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
  const vehicleId = params.get("id");
  const pageTitle = document.querySelector("#page-title");
  const pageSubtitle = document.querySelector("#page-subtitle");
  const detailLink = document.querySelector("#detail-link");
  const photoInput = document.querySelector("#photo-input");
  const photoMessage = document.querySelector("#photo-message");
  const photoCount = document.querySelector("#photo-count");
  const selectedCount = document.querySelector("#selected-count");
  const carousel = document.querySelector("#photo-carousel");
  const selectedList = document.querySelector("#selected-photos");

  const vehiclesResponse = await fetch("/api/vehicles");
  const data = await vehiclesResponse.json();
  const vehicle = (data.vehicles || []).find((item) => item.id === vehicleId);

  if (!vehicle) {
    pageTitle.textContent = "Camper niet gevonden";
    pageSubtitle.textContent = "Ga terug naar het overzicht en kies opnieuw een camper.";
    return;
  }

  let photos = normalizePhotos(vehicle.photos);
  let draggedPhotoId = null;
  detailLink.href = `/camper-detail.html?id=${encodeURIComponent(vehicle.id)}`;
  pageTitle.textContent = vehicle.sourceId || vehicle.id;
  pageSubtitle.textContent = vehicle.title || "Foto's beheren";
  renderPhotos();

  photoInput.addEventListener("change", async () => {
    const files = [...photoInput.files].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;

    photoMessage.textContent = "Foto's uploaden...";
    const payloadPhotos = await Promise.all(files.map(async (file) => ({
      name: file.webkitRelativePath || file.name,
      dataUrl: await readFileAsDataUrl(file)
    })));

    const response = await fetch(`/api/vehicles/${encodeURIComponent(vehicle.id)}/photos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ photos: payloadPhotos })
    });
    const result = await response.json();

    if (!response.ok) {
      photoMessage.textContent = result.message || "Upload mislukt";
      return;
    }

    photos = normalizePhotos(result.photos);
    photoInput.value = "";
    photoMessage.textContent = "Foto's toegevoegd";
    renderPhotos();
  });

  carousel.addEventListener("click", async (event) => {
    const card = event.target.closest(".photo-card");
    if (!card) return;

    if (event.target.closest("[data-delete-photo]")) {
      const photo = photos.find((item) => item.id === card.dataset.photoId);
      if (!photo || !window.confirm(`Weet je zeker dat je "${photo.name}" wilt verwijderen?`)) return;
      await deletePhoto(photo.id);
      return;
    }

    if (event.target.closest("[data-select-photo]")) {
      const photo = photos.find((item) => item.id === card.dataset.photoId);
      if (!photo) return;
      photo.selected = !photo.selected;
      await savePhotoState();
      renderPhotos();
    }
  });

  selectedList.addEventListener("dragstart", (event) => {
    const item = event.target.closest(".selected-photo");
    if (!item) return;
    draggedPhotoId = item.dataset.photoId;
    event.dataTransfer.effectAllowed = "move";
  });

  selectedList.addEventListener("dragover", (event) => {
    event.preventDefault();
    autoScroll(event.clientY);
    const overItem = event.target.closest(".selected-photo");
    if (!overItem || overItem.dataset.photoId === draggedPhotoId) return;

    const draggedIndex = photos.findIndex((photo) => photo.id === draggedPhotoId);
    const overIndex = photos.findIndex((photo) => photo.id === overItem.dataset.photoId);
    if (draggedIndex < 0 || overIndex < 0) return;

    const [dragged] = photos.splice(draggedIndex, 1);
    photos.splice(overIndex, 0, dragged);
    renderPhotos();
  });

  selectedList.addEventListener("dragend", async () => {
    draggedPhotoId = null;
    await savePhotoState();
  });

  async function deletePhoto(photoId) {
    const response = await fetch(`/api/vehicles/${encodeURIComponent(vehicle.id)}/photos/${encodeURIComponent(photoId)}`, {
      method: "DELETE"
    });
    const result = await response.json();
    if (!response.ok) {
      photoMessage.textContent = result.message || "Verwijderen mislukt";
      return;
    }
    photos = normalizePhotos(result.photos);
    photoMessage.textContent = "Foto verwijderd";
    renderPhotos();
  }

  async function savePhotoState() {
    const payload = {
      ...vehicle,
      photos
    };
    const response = await fetch(`/api/vehicles/${encodeURIComponent(vehicle.id)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (response.ok) {
      photos = normalizePhotos(result.vehicle.photos);
    }
  }

  function renderPhotos() {
    photoCount.textContent = photos.length;
    selectedCount.textContent = photos.filter((photo) => photo.selected).length;
    carousel.innerHTML = photos.length ? photos.map((photo) => `
      <article class="photo-card${photo.selected ? " is-selected" : ""}" data-photo-id="${escapeHtml(photo.id)}">
        <img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.name)}">
        <div>
          <strong>${escapeHtml(photo.name)}</strong>
          <div class="row-actions">
            <button class="secondary-button small-button" type="button" data-select-photo>${photo.selected ? "Deselecteren" : "Selecteren"}</button>
            <button class="danger-button small-button" type="button" data-delete-photo>Verwijderen</button>
          </div>
        </div>
      </article>
    `).join("") : `<p class="empty-state">Nog geen foto's geupload.</p>`;

    const selectedPhotos = photos.filter((photo) => photo.selected);
    selectedList.innerHTML = selectedPhotos.length ? selectedPhotos.map((photo) => `
      <article class="selected-photo" data-photo-id="${escapeHtml(photo.id)}" draggable="true">
        <img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.name)}">
        <strong>${escapeHtml(photo.name)}</strong>
      </article>
    `).join("") : `<p class="empty-state">Selecteer foto's om de volgorde te bepalen.</p>`;
  }
})();

function normalizePhotos(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((photo) => ({
      id: String(photo.id || ""),
      name: String(photo.name || "foto"),
      url: String(photo.url || ""),
      selected: Boolean(photo.selected)
    }))
    .filter((photo) => photo.id && photo.url);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function autoScroll(clientY) {
  const edge = 90;
  const speed = 18;
  if (clientY < edge) window.scrollBy(0, -speed);
  if (window.innerHeight - clientY < edge) window.scrollBy(0, speed);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
