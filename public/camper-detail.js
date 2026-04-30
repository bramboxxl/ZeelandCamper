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
  const todoList = document.querySelector("#todo-list");
  const todosField = document.querySelector("#todos-field");
  const addTodoButton = document.querySelector("#add-todo");
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
  let todos = normalizeTodos(vehicle.todos);

  previousLink.href = `/camper-detail.html?id=${encodeURIComponent(previousVehicle.id)}`;
  nextLink.href = `/camper-detail.html?id=${encodeURIComponent(nextVehicle.id)}`;
  positionLabel.textContent = `${selectedIndex + 1} / ${vehicles.length}`;
  pageTitle.textContent = vehicle.sourceId || vehicle.id;
  pageSubtitle.textContent = vehicle.title || "Camperdetails";
  formTitle.textContent = `${vehicle.sourceId || vehicle.id} - ${vehicle.title || "Camper"}`;

  Object.entries(vehicle).forEach(([key, value]) => {
    if (form.elements[key] && key !== "todos") {
      form.elements[key].value = value || "";
    }
  });

  if (form.elements.status) {
    form.elements.status.value = vehicle.status || vehicle.notes || "Te koop";
  }

  renderTodos();

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
    payload.status = payload.notes || "Te koop";
    payload.todos = cleanTodosForSave(todos);

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
    renderTodos();
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
