const capFileInput = document.getElementById("capFileInput");
const packageInfoDiv = document.getElementById("packageInfo");

capFileInput.addEventListener("change", function(event) {
  const file = event.target.files[0];
  if (file) {

    // check if file name ends with .cap
    if (!file.name.toLowerCase().endsWith('.cap') && !file.name.toLowerCase().endsWith('.zip')) {
      packageInfoDiv.textContent = 'Please select a .cap file';
      return;
    }

    const reader = new FileReader();
    reader.onload = function(event) {
      /**
       * Understand, here base64 is quite important, since we can't send arrayBuffer or Blob directly
       */
      const base64String = event.target.result.split(",")[1];
      chrome.runtime.sendMessage({ action: "openCapFile", fileBase64: base64String }, function(response) {
        if (response.error) {
          packageInfoDiv.textContent = response.error;
        } else {
          displayPackageInfo(response);
        }
      });
    };
    reader.readAsDataURL(file);
  }
});

function displayPackageInfo(packageResponse) {

  console.log(packageResponse);

  packageInfoDiv.innerHTML = `
    <h2>Package Info</h2>
    <p><strong>Name:</strong> ${packageResponse.metadata.name}</p>
    <p><strong>Version:</strong> ${packageResponse.metadata.version}</p>
    <h3>Routes</h3>
    <ul>
      ${packageResponse.routes.routes.map(route => `<li>${route.path} -> ${route.target.file}</li>`).join('')}
    </ul>
  `;
}