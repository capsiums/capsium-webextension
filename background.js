importScripts("./jszip.min.js");

const capIdsWithTimeAddedStorageKey = "capIdsWithTimeAdded";
const maxCapAge = 1000 * 60 * 30; // 30 minutes

async function storeCapContents(manifest, routes, zip) {
  // manifest.json format, It contains an content as a array of objects
  // Where key is the file name and value is the content type
  // {
  // "content": [{"file": "example.css", "type": "text/css"}, {"file": "example.js", "type": "text/javascript"]
  // }
  //
  // routes.json format, It contains the routes as a array of objects
  // Where key is the path and value is the target file
  // {
  // "routes": [
  // {
  //    "path": "/",
  //    "target": {
  //      "file": "index.html"
  //    }
  //   },
  //  {
  //    "path": "/index",
  //    "target": {
  //      "file": "index.html"
  //    }
  //  },
  //  {
  //    "path": "/index.html",
  //    "target": {
  //      "file": "index.html"
  //    }
  //  },
  //  {
  //    "path": "/example.css",
  //    "target": {
  //      "file": "example.css"
  //    }
  //  },
  //  {
  //    "path": "/example.js",
  //    "target": {
  //      "file": "example.js"
  //    }
  //  }
  // ]
  //}

  // Create a unique id for the CAP package
  const capId = crypto.randomUUID();

  const contentIds = [];
  // Loop over each file in the manifest and read the content
  for (const { file, mime } of manifest.content) {

    const fileName = file;
    const contentType = mime;

    const contentPath = `content/${fileName}`

    let fileContent = await zip.file(contentPath)?.async("text");

    if (!fileContent) {
      throw new Error(`File ${contentPath} not found in the CAP package`);
    }

    // If file is html, we need to replace the relative paths with absolute paths
    // Without DOMParser, since we are in the background script
    if (contentType === "text/html") {
      
      const promise = new Promise((resolve, reject) => {
        const listener = async (message) => {
          if (message.type === 'domParser') {
            chrome.runtime.onMessage.removeListener(listener);
            resolve(message.content);
          }
        }
        chrome.runtime.onMessage.addListener(listener);
      });

      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL('domParserOffscreen.html'),
        reasons: [chrome.offscreen.Reason.DOM_PARSER],
        justification: 'We need to parse the HTML file to replace relative paths with absolute paths',
      });

      chrome.runtime.sendMessage({
        type: 'domParser',
        content: fileContent,
        capId: capId
      });

      fileContent = await promise;
      await chrome.offscreen.closeDocument();
    }

    const fileId = `${capId}-${fileName}`;

    // store it in the storage
    await chrome.storage.local.set({ [fileId]: { type: 'content', fileName, contentType, fileContent } });

    // Add the content id to the list of content ids
    contentIds.push(fileId);
  }

  // store the manifest, routes and contentIds in the storage
  await chrome.storage.local.set({
    [capId]: {
      type: 'capInfo',
      manifest,
      routes,
      contentIds
    }
  });

  // Storing the capId with current time in the storage
  // This is used to delete the CAP package after a certain time
  const capIdsWithTimeAddedResponse = await chrome.storage.local.get([capIdsWithTimeAddedStorageKey]);

  const capIdsWithTimeAdded = capIdsWithTimeAddedResponse[capIdsWithTimeAddedStorageKey] || [];

  capIdsWithTimeAdded.push({ capId, timeAdded: Date.now() });

  await chrome.storage.local.set({ [capIdsWithTimeAddedStorageKey]: capIdsWithTimeAdded });

  return capId;
}

const convertTextToDataURI = async (text, contentType) => {

  const blob = new Blob([text], { type: contentType });

  const dataURI = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  })

  return dataURI;
}

async function setupCapRedirectRules(capId, routes) {

  let id = 1;

  const rules = [];
  const deleteIds = [];

  await Promise.all(routes.map(async ({ path, target }) => {
    const url = `https://${capId}.cap${path}`;

    const fileToUse = target.file;

    const fileId = `${capId}-${fileToUse}`;

    const contentInfo = await chrome.storage.local.get([fileId]);

    if (!contentInfo[fileId]) {
      throw new Error(`Content file ${fileToUse} not found for route ${path}`);
    }

    const { contentType, fileContent } = contentInfo[fileId];

    const dataURI = await convertTextToDataURI(fileContent, contentType);

    const rule = {
      id: id++,
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          url: dataURI
        }
      },
      condition: {
        urlFilter: url,
        resourceTypes: [
          "main_frame",
          "sub_frame",
          "stylesheet",
          "script",
          "image",
          "font",
          "media"
        ]
      }
    };

    deleteIds.push(rule.id);
    rules.push(rule);
  }));

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: deleteIds,
    addRules: rules
  });
}

async function readCapFile(fileDataURI) {

  // Convert the data URI to binary array buffer
  // We can definitely use atob here, but our dataURI can have special characters
  const blob = await fetch(fileDataURI).then(res => res.blob());

  const zip = await JSZip.loadAsync(blob);

  const metadata = JSON.parse(await zip.file("metadata.json").async("text"));
  const manifest = JSON.parse(await zip.file("manifest.json").async("text"));
  const routes = JSON.parse(await zip.file("routes.json").async("text"));

  try {
    const capId = await storeCapContents(manifest, routes, zip);
    await setupCapRedirectRules(capId, routes.routes);

    // Open a new tab with the CAP package URL
    chrome.tabs.create({ url: `https://${capId}.cap/` });

    return { metadata, manifest, routes, capId };
  } catch (error) {
    return { error: error.message };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "openCapFile") {
    /**
     * Understand, here dataURI is quite important, since we can't send arrayBuffer or Blob directly
     */
    const fileDataURI = message.dataURI;

    readCapFile(fileDataURI).then((pkg) => {
      sendResponse(pkg);
    }).catch((error) => {
      console.error("Error reading .cap file:", error);
      sendResponse({ error: "Failed to read .cap file" });
    });

    return true; // Keep the message channel open for async response
  }
});

// Setup a cron job to delete CAP packages that are older than maxCapAge
chrome.alarms.create("30min", {
  delayInMinutes: 30,
  periodInMinutes: 30
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "30min") {
    let capIdsWithTimeAddedResponse = await chrome.storage.local.get([capIdsWithTimeAddedStorageKey]);

    let capIdsWithTimeAdded = capIdsWithTimeAddedResponse[capIdsWithTimeAddedStorageKey] || [];

    const currentTime = Date.now();

    for (const { capId, timeAdded } of capIdsWithTimeAdded) {
      if (currentTime - timeAdded > maxCapAge) {
        // Delete the CAP package
        const capInfo = await chrome.storage.local.get(capId);
        if (capInfo) {
          for (const contentId of capInfo.contentIds) {
            await chrome.storage.local.remove(contentId);
          }
          await chrome.storage.local.remove(capId);
        }

        // Remove the capId from the list of capIdsWithTimeAdded
        capIdsWithTimeAdded = capIdsWithTimeAdded.filter((item) => item.capId !== capId);
      }
    }

    await chrome.storage.local.set({ [capIdsWithTimeAddedStorageKey]: capIdsWithTimeAdded });
  }
});

/**
 * This doesn't work since filterResponseData is not available in the chrome till now.
 * What i was trying to do here being
 * 1. Intercept the request
 * 2. When user open the url CapId.cap, it should return the content of the capId based on the routes
 * 3. We will fetch the capId from the url, will try to find it's data from the storage
 * 4. We will then conditionally check the routes and return the content based on the routes
 * 5. If the route is not found, we will return the default content
 * 6. This way it's like capId.cap we have deployed our server.
 * 
 * But here the problem is, chrome don't allow us to modify the response of the request
 * 
 * 
 * 2nd approach was when user open the url CapId.cap, we will modify the content after page load or before page load starts using content script.
 * But here problem is this will not work for static contents like JS and CSS files.
 * 
 * So, we need to find a way to intercept the request and modify the response.
 */
/* chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [
    1,2,3,4,5,6,7,8,9,10,11,12
  ],
  addRules: [
    {
      id: 2,
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          url: "data:text/javascript;base64,YWxlcnQoIkhlbGxvIGFuZCB3ZWxjb21lIik="
        }
      },
      condition: {
        regexFilter: "https://www\\.w3schools\\.com/lib/common-deps\\.js\\?v=[0-9]+\\.[0-9]+\\.[0-9]+",
        resourceTypes: [
          "main_frame",
          "sub_frame",
          "stylesheet",
          "script",
          "image",
          "font",
          "media"
        ]
      }
    }
  ]
}, () => {
  console.log("Rules added");
})

chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(
  (e) => console.log("onRuleMatchedDebug" + JSON.stringify(e))
); */