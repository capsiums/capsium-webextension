document.getElementById("capFileInput").addEventListener("change", function(event) {
  const file = event.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = function(event) {
      const arrayBuffer = event.target.result;
      chrome.runtime.sendMessage({ action: "openCapFile", file: arrayBuffer }, function(response) {
        if (response.error) {
          document.getElementById("packageInfo").textContent = response.error;
        } else {
          displayPackageInfo(response);
        }
      });
    };
    reader.readAsArrayBuffer(file);
  }
});

function displayPackageInfo(package) {
  const infoDiv = document.getElementById("packageInfo");
  infoDiv.innerHTML = `
    <h2>Package Info</h2>
    <p><strong>Name:</strong> ${package.metadata.name}</p>
    <p><strong>Version:</strong> ${package.metadata.version}</p>
    <h3>Routes</h3>
    <ul>
      ${package.routes.routes.map(route => `<li>${route.path} -> ${route.target.file}</li>`).join('')}
    </ul>
  `;
}