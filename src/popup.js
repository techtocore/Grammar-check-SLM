// popup.js - handles interaction with the extension's popup, sends requests to the
// service worker (background.js), and updates the popup's UI (popup.html) on completion.

document.addEventListener('DOMContentLoaded', async () => {
    const statusSection = document.getElementById('status-section');
    const statusIndicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');

    try {
        // Get the active tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        // Check if we can inject scripts into this tab
        if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
            updateStatus('warning', 'Cannot check system pages');
            return;
        }

        // Inject a script to check for editable areas
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            function: checkForEditableAreas
        });

        const hasEditableAreas = results[0].result;
        
        if (hasEditableAreas) {
            updateStatus('active', 'Active on this page');
        } else {
            updateStatus('warning', 'No supported text fields found');
        }

    } catch (error) {
        console.error('Error checking page status:', error);
        updateStatus('warning', 'Unable to check this page');
    }

    function updateStatus(type, message) {
        // Remove all status classes
        statusSection.className = 'status-section';
        statusIndicator.className = 'status-indicator';
        statusText.className = 'status-text';
        
        // Add new status classes
        statusSection.classList.add(type);
        statusIndicator.classList.add(type);
        statusText.classList.add(type);
        statusText.textContent = message;
    }
});

// Function to be injected into the page to check for editable areas
function checkForEditableAreas() {
    // Check for elements with class "editable-area"
    const editableAreas = document.querySelectorAll('.editable-area');
    return editableAreas.length > 0;
}