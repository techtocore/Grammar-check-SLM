// background.js - Simplified communication handler
console.log("Background script starting...");

// Keep-alive functionality
const KEEP_ALIVE_ALARM = 'keep-alive-alarm';

chrome.runtime.onStartup.addListener(() => {
    console.log('BACKGROUND: onStartup event.');
    createKeepAlive();
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEP_ALIVE_ALARM) {
        console.log('BACKGROUND: Keep-alive alarm fired.');
    }
});

function createKeepAlive() {
    chrome.alarms.get(KEEP_ALIVE_ALARM, (alarm) => {
        if (!alarm) {
            chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 0.5 });
            console.log('BACKGROUND: Keep-alive alarm created.');
        }
    });
}

createKeepAlive();

// Handle grammar check requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'checkGrammar') {
        console.log("BACKGROUND: Received grammar check request, forwarding to content script.");
        
        // Get the active tab and send message to its content script
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error("BACKGROUND: Error communicating with content script:", chrome.runtime.lastError);
                        sendResponse({ corrections: [] });
                    } else {
                        console.log("BACKGROUND: Received response from content script:", response);
                        sendResponse(response);
                    }
                });
            } else {
                console.error("BACKGROUND: No active tab found.");
                sendResponse({ corrections: [] });
            }
        });
        
        return true; // Keep message channel open
    }
});

console.log("Grammar check background script loaded.");