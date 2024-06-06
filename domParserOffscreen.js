chrome.runtime.onMessage.addListener(async (msg) => {

    if(msg.type !== 'domParser') {
        return;
    }

    // With message we will receive an html file
    const doc = new DOMParser().parseFromString(msg.content, 'text/html');

    const elements = doc.querySelectorAll("link[rel=stylesheet], script[src]");

    for (const element of elements) {
        const src = element.getAttribute("href") || element.getAttribute("src");

        if (src && !src.startsWith("http")) {
            const newSrc = `https://${msg.capId}.cap${src}`;
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