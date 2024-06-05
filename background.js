// Include the JSZip and JSON libraries
importScripts('jszip.min.js');

async function readCapFile(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const metadata = JSON.parse(await zip.file("metadata.json").async("text"));
  const manifest = JSON.parse(await zip.file("manifest.json").async("text"));
  const routes = JSON.parse(await zip.file("routes.json").async("text"));

  return { metadata, manifest, routes, zip };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "openCapFile") {
    const arrayBuffer = message.file;
    readCapFile(arrayBuffer).then((pkg) => {
      sendResponse(pkg);
    }).catch((error) => {
      console.error("Error reading .cap file:", error);
      sendResponse({ error: "Failed to read .cap file" });
    });
    return true; // Keep the message channel open for async response
  }
});