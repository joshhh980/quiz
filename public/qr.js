const destination = document.querySelector("#qr-destination");

fetch("/api/projector-url")
  .then((response) => {
    if (!response.ok) throw new Error(`Could not load projector URL (${response.status}).`);
    return response.json();
  })
  .then(({ url }) => {
    destination.textContent = url;
  })
  .catch((error) => {
    console.error("Could not load the QR destination:", error);
    destination.textContent = "Set APP_URL in the server environment to show the projector link.";
  });
