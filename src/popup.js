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

        // Check the model status first
        const modelStatusResponse = await chrome.runtime.sendMessage({ type: 'getModelStatus' });
        const modelStatus = modelStatusResponse.status;

        if (modelStatus === 'loading') {
            updateStatus('loading', 'Loading AI model...');
            
            // Poll for model status until it's ready
            const pollInterval = setInterval(async () => {
                try {
                    const statusResponse = await chrome.runtime.sendMessage({ type: 'getModelStatus' });
                    if (statusResponse.status === 'ready') {
                        clearInterval(pollInterval);
                        checkPageCompatibility(tab);
                    }
                } catch (error) {
                    console.error('Error polling model status:', error);
                    clearInterval(pollInterval);
                    updateStatus('warning', 'Model loading failed');
                }
            }, 1000);
            
            return;
        } else if (modelStatus === 'not-loaded') {
            updateStatus('loading', 'Initializing AI model...');
            
            // Wait a bit and check again, as the model might be starting to load
            setTimeout(async () => {
                try {
                    const statusResponse = await chrome.runtime.sendMessage({ type: 'getModelStatus' });
                    if (statusResponse.status === 'ready') {
                        checkPageCompatibility(tab);
                    } else {
                        updateStatus('warning', 'Model initialization failed');
                    }
                } catch (error) {
                    console.error('Error checking model status:', error);
                    updateStatus('warning', 'Model initialization failed');
                }
            }, 2000);
            
            return;
        } else if (modelStatus === 'ready') {
            checkPageCompatibility(tab);
        }

    } catch (error) {
        console.error('Error checking page status:', error);
        updateStatus('warning', 'Unable to check this page');
    }

    async function checkPageCompatibility(tab) {
        try {
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
            console.error('Error checking editable areas:', error);
            updateStatus('warning', 'Unable to check this page');
        }
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