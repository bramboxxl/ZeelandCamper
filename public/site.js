(async () => {
  const loginLink = document.querySelector(".nav-button[href='/login.html']");
  if (!loginLink) return;

  try {
    const response = await fetch("/api/session");
    const session = await response.json();

    if (session.authenticated) {
      loginLink.textContent = "Dashboard";
      loginLink.href = "/dashboard";
    }
  } catch {
    loginLink.textContent = "Login";
  }
})();
