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
  const photosLink = document.querySelector("#photos-link");
  const todoList = document.querySelector("#todo-list");
  const todosField = document.querySelector("#todos-field");
  const addTodoButton = document.querySelector("#add-todo");
  const rdwLookupButton = document.querySelector("#rdw-lookup-button");
  const rdwMessage = document.querySelector("#rdw-message");
  const rdwField = document.querySelector("#rdw-finnik-field");
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

  const selectedIndex = Math.max(0, vehicles.findIndex((item) => item.id === requestedId));
  const vehicle = vehicles[selectedIndex];
  const previousVehicle = vehicles[(selectedIndex - 1 + vehicles.length) % vehicles.length];
  const nextVehicle = vehicles[(selectedIndex + 1) % vehicles.length];
  let todos = normalizeTodos(vehicle.todos);
  let rdwFinnikData = normalizeRdwFinnikData(vehicle.rdwFinnikData);

  previousLink.href = `/camper-detail.html?id=${encodeURIComponent(previousVehicle.id)}`;
  nextLink.href = `/camper-detail.html?id=${encodeURIComponent(nextVehicle.id)}`;
  photosLink.href = `/photos.html?id=${encodeURIComponent(vehicle.id)}`;
  positionLabel.textContent = `${selectedIndex + 1} / ${vehicles.length}`;
  pageTitle.textContent = vehicle.sourceId || vehicle.id;
  pageSubtitle.textContent = vehicle.title || "Camperdetails";
  formTitle.textContent = `${vehicle.sourceId || vehicle.id} - ${vehicle.title || "Camper"}`;

  Object.entries(vehicle).forEach(([key, value]) => {
    if (form.elements[key] && key !== "todos" && key !== "rdwFinnikData") {
      form.elements[key].value = value || "";
    }
  });

  if (form.elements.status) {
    form.elements.status.value = vehicle.status || "Op het oog";
  }

  renderTodos();
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

      rdwFinnikData = normalizeRdwFinnikData(result.data);
      applyRdwDataToForm(rdwFinnikData);
      renderRdwFinnikData();
      rdwMessage.textContent = "Data opgehaald. Klik op Opslaan om te bewaren.";
    } catch (error) {
      rdwMessage.textContent = error.message || "Ophalen mislukt";
    } finally {
      rdwLookupButton.disabled = false;
    }
  });

  addTodoButton.addEventListener("click", () => {
    todos.push({
      id: createTodoId(),
      text: "",
      done: false
    });
    renderTodos();

    const lastInput = todoList.querySelector(".todo-row:last-child .todo-input");
    if (lastInput) lastInput.focus();
  });

  todoList.addEventListener("input", (event) => {
    const row = event.target.closest(".todo-row");
    if (!row || !event.target.classList.contains("todo-input")) return;

    const todo = todos.find((item) => item.id === row.dataset.todoId);
    if (todo) {
      todo.text = event.target.value;
      syncTodosField();
    }
  });

  todoList.addEventListener("change", (event) => {
    const row = event.target.closest(".todo-row");
    if (!row || !event.target.classList.contains("todo-checkbox")) return;

    const todo = todos.find((item) => item.id === row.dataset.todoId);
    if (todo) {
      todo.done = event.target.checked;
      row.classList.toggle("is-done", todo.done);
      syncTodosField();
    }
  });

  todoList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-todo]");
    if (!button) return;

    const row = button.closest(".todo-row");
    todos = todos.filter((item) => item.id !== row.dataset.todoId);
    renderTodos();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";

    const formData = new FormData(form);
    const id = formData.get("id");
    const payload = Object.fromEntries(formData.entries());
    delete payload.id;
    payload.todos = cleanTodosForSave(todos);
    payload.rdwFinnikData = rdwFinnikData;

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

    todos = normalizeTodos(result.vehicle.todos);
    rdwFinnikData = normalizeRdwFinnikData(result.vehicle.rdwFinnikData);
    renderTodos();
    renderRdwFinnikData();
    message.textContent = "Opgeslagen";
    pageSubtitle.textContent = result.vehicle.title || "Camperdetails";
    formTitle.textContent = `${result.vehicle.sourceId || result.vehicle.id} - ${result.vehicle.title || "Camper"}`;
  });

  function renderTodos() {
    if (!todos.length) {
      todoList.innerHTML = `<p class="empty-state compact">Nog geen todo punten voor deze camper.</p>`;
      syncTodosField();
      return;
    }

    todoList.innerHTML = todos.map((todo) => `
      <div class="todo-row${todo.done ? " is-done" : ""}" data-todo-id="${escapeHtml(todo.id)}">
        <label class="todo-check-label" aria-label="Todo afgerond">
          <input class="todo-checkbox" type="checkbox"${todo.done ? " checked" : ""}>
        </label>
        <input class="todo-input" type="text" value="${escapeHtml(todo.text)}" placeholder="Todo regel">
        <button class="danger-button small-button" type="button" data-remove-todo>Verwijder</button>
      </div>
    `).join("");
    syncTodosField();
  }

  function syncTodosField() {
    todosField.value = JSON.stringify(cleanTodosForSave(todos));
  }

  function renderRdwFinnikData() {
    rdwField.value = JSON.stringify(rdwFinnikData || {});
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
    if (data.tradeName && !form.elements.title.value.trim()) form.elements.title.value = `${data.make} ${data.tradeName}`.trim();
    if (data.fuelType && !form.elements.additionalInfo.value.includes(data.fuelType)) {
      form.elements.additionalInfo.value = [form.elements.additionalInfo.value, `Brandstof: ${data.fuelType}`].filter(Boolean).join("\n");
    }
  }
})();

function normalizeTodos(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((todo) => ({
      id: String(todo.id || createTodoId()),
      text: String(todo.text || "").trim(),
      done: Boolean(todo.done)
    }))
    .filter((todo) => todo.text);
}

function cleanTodosForSave(todos) {
  return todos
    .map((todo) => ({
      id: todo.id || createTodoId(),
      text: String(todo.text || "").trim(),
      done: Boolean(todo.done)
    }))
    .filter((todo) => todo.text);
}

function normalizeRdwFinnikData(value) {
  return value && typeof value === "object" ? value : {};
}

function rdwRows(data) {
  return [
    ["Kenteken", data.licensePlate],
    ["Merk", data.make],
    ["Handelsbenaming", data.tradeName],
    ["Voertuigsoort", data.vehicleType],
    ["Inrichting", data.bodyType],
    ["Brandstof", data.fuelType],
    ["Afmetingen", formatDimensions(data)],
    ["Zitplaatsen", data.seats],
    ["Massa rijklaar", formatKg(data.massReady)],
    ["Ledige massa", formatKg(data.emptyMass)],
    ["Maximum massa", formatKg(data.maxMass)],
    ["APK tot", data.apkUntil],
    ["Eerste toelating", data.firstAdmission],
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

function formatKg(value) {
  return value ? `${value} kg` : "";
}

function createTodoId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `todo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
