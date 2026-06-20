(async () => {
  const logoutButton = document.querySelector("#logout-button");
  if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST" });
      window.location.href = "/";
    });
  }

  const form = document.querySelector("#showroom-form");
  const input = document.querySelector("#license-plate");
  const button = document.querySelector("#showroom-submit");
  const message = document.querySelector("#showroom-message");
  const params = new URLSearchParams(window.location.search);

  await prefillLicensePlate(params);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await downloadShowroomCard();
  });

  if (input.value.trim()) {
    await downloadShowroomCard();
  }

  async function downloadShowroomCard() {
    message.textContent = "";
    button.disabled = true;
    button.textContent = "Showroomkaart maken...";

    try {
      const response = await fetch("/api/showroomkaart", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          licensePlate: normalizeLicensePlate(input.value)
        })
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.message || "Showroomkaart maken mislukt");
      }

      const blob = await response.blob();
      const fileName = getDownloadFileName(response.headers.get("content-disposition")) || "showroomkaart.docx";
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
      message.textContent = "Download gestart.";
    } catch (error) {
      message.textContent = error.message || "Showroomkaart maken mislukt";
    } finally {
      button.disabled = false;
      button.textContent = "Showroomkaart downloaden";
    }
  }

  async function prefillLicensePlate(params) {
    const kenteken = normalizeLicensePlate(params.get("kenteken"));
    if (kenteken) {
      input.value = kenteken;
      return;
    }

    const vehicleId = params.get("id");
    if (!vehicleId) return;

    try {
      const response = await fetch("/api/vehicles");
      const data = await response.json();
      const vehicle = (data.vehicles || []).find((item) => String(item.id) === vehicleId);
      const licensePlate = normalizeLicensePlate(vehicle?.licensePlate);
      if (licensePlate) input.value = licensePlate;
    } catch {
      message.textContent = "Kenteken kon niet automatisch worden ingevuld.";
    }
  }
})();

function normalizeLicensePlate(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function getDownloadFileName(header) {
  const match = String(header || "").match(/filename="([^"]+)"/i);
  if (!match) return "";
  return decodeURIComponent(match[1]);
}
