/** Injects the content bundle into tabs that were already open when the extension was installed. */
export async function activateExistingTabs(): Promise<number> {
  const tabs = await chrome.tabs.query({});
  let activated = 0;

  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      if (tab.url) {
        const protocol = new URL(tab.url).protocol;
        if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'file:') return;
      }
      const target = { tabId: tab.id, allFrames: true };
      try {
        await chrome.scripting.insertCSS({ target, files: ['content.css'] });
        await chrome.scripting.executeScript({ target, files: ['content.js'] });
        const response = await chrome.tabs.sendMessage<
          { type: string; target: string },
          {
            ready: boolean;
          }
        >(tab.id, { type: 'gc-ready-probe', target: 'content' }, { frameId: 0 });
        if (!response.ready) return;
        activated++;
      } catch {
        // Restricted browser pages and tabs without host access are expected.
      }
    }),
  );

  return activated;
}
