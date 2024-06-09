chrome.runtime.onMessage.addListener(async (msg) => {

    if(msg.type !== 'domParser') {
        return;
    }

    // With message we will receive an html file
    const doc = new DOMParser().parseFromString(msg.content, 'text/html');

    const elements = doc.querySelectorAll("link[rel=stylesheet], script[src] , img[src], a[href]");

    for (const element of elements) {
        let src = element.getAttribute("href") || element.getAttribute("src");

        if (src && !src.startsWith("http")) {

            let newSrc;

            if(element.tagName === "A") {
                if(src.startsWith("#")) {
                    continue;
                }
            }

            // If src starts with /
            if (src.startsWith("/")) {
                newSrc = `https://${msg.capId}.cap${src}`;
            } else {

                const currentPath = location.pathname;
                const currentPathParts = currentPath.split("/");
                currentPathParts.pop();
                const newPath = currentPathParts.join("/");
                newSrc = `https://${msg.capId}.cap${newPath}/${src}`;
            }

            
            element.setAttribute("href", newSrc);
            element.setAttribute("src", newSrc);
        }
    }

    const fileContent = doc.documentElement.outerHTML;

    chrome.runtime.sendMessage({
        type: 'domParser',
        content: fileContent,
    });
});