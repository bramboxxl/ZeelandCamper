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

  if (params.get("kenteken")) {
    input.value = params.get("kenteken");
  }

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
          licensePlate: input.value.trim()
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
})();

function getDownloadFileName(header) {
  const match = String(header || "").match(/filename="([^"]+)"/i);
  if (!match) return "";
  return decodeURIComponent(match[1]);
}
