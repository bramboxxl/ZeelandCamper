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

  const overview = document.querySelector("#todo-overview");
  const count = document.querySelector("#todo-count");
  const firstDetailLink = document.querySelector("#first-detail-link");

  const vehiclesResponse = await fetch("/api/vehicles");
  const data = await vehiclesResponse.json();
  let vehicles = data.vehicles || [];

  if (!vehicles.length) {
    overview.innerHTML = `<p class="empty-state">Nog geen campers in de database.</p>`;
    firstDetailLink.setAttribute("aria-disabled", "true");
    count.textContent = "0";
    return;
  }

  firstDetailLink.href = `/camper-detail.html?id=${encodeURIComponent(vehicles[0].id)}`;
  renderOverview();

  overview.addEventListener("change", async (event) => {
    const checkbox = event.target.closest(".todo-checkbox");
    if (!checkbox) return;

    const item = checkbox.closest(".todo-item");
    const camperCard = checkbox.closest(".todo-camper-card");
    const vehicle = vehicles.find((camper) => camper.id === camperCard.dataset.vehicleId);
    if (!vehicle) return;

    const todos = normalizeTodos(vehicle.todos).map((todo) => (
      todo.id === item.dataset.todoId ? { ...todo, done: checkbox.checked } : todo
    ));
    const previousTodos = vehicle.todos || [];
    vehicle.todos = todos;
    item.classList.toggle("is-done", checkbox.checked);
    checkbox.disabled = true;

    try {
      const response = await fetch(`/api/vehicles/${encodeURIComponent(vehicle.id)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...vehicle,
          todos
        })
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || "Todo kon niet worden opgeslagen");
      }

      vehicle.todos = normalizeTodos(result.vehicle.todos);
      renderOverview();
    } catch (error) {
      vehicle.todos = previousTodos;
      renderOverview();
      window.alert(error.message || "Todo kon niet worden opgeslagen");
    }
  });

  function renderOverview() {
    const totalTodos = vehicles.reduce((total, vehicle) => total + normalizeTodos(vehicle.todos).length, 0);
    count.textContent = totalTodos;

    overview.innerHTML = vehicles.map((vehicle) => {
      const todos = normalizeTodos(vehicle.todos);
      return `
        <article class="todo-camper-card" data-vehicle-id="${escapeHtml(vehicle.id)}">
          <div class="todo-camper-header">
            <div>
              <span class="vehicle-status">${escapeHtml(vehicle.sourceId || vehicle.id)}</span>
              <h3>${escapeHtml(vehicle.title || "Camper")}</h3>
              <p>${escapeHtml(vehicle.licensePlate || "Geen kenteken")}</p>
            </div>
            <a class="secondary-button small-button" href="/camper-detail.html?id=${encodeURIComponent(vehicle.id)}">Details</a>
          </div>
          <div class="todo-items">
            ${todos.length ? todos.map((todo) => `
              <label class="todo-item${todo.done ? " is-done" : ""}" data-todo-id="${escapeHtml(todo.id)}">
                <input class="todo-checkbox" type="checkbox"${todo.done ? " checked" : ""}>
                <span>${escapeHtml(todo.text)}</span>
              </label>
            `).join("") : `<p class="empty-state compact">Geen todo punten.</p>`}
          </div>
        </article>
      `;
    }).join("");
  }
})();

function normalizeTodos(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((todo) => ({
      id: String(todo.id || ""),
      text: String(todo.text || "").trim(),
      done: Boolean(todo.done)
    }))
    .filter((todo) => todo.id && todo.text);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
