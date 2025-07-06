
let isChecking = false;

// A simple debounce function to prevent firing on every keystroke
function debounce(func, delay) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), delay);
    };
}

// --- UI Logic: Highlighting ---
function highlightMistakes(element, mistakes) {
    let originalHTML = element.innerHTML;
    let newHTML = originalHTML;

    mistakes.forEach(mistake => {
        // Use a more robust regex to avoid matching parts of words or HTML tags.
        // It looks for the word with a word boundary (\\b) on either side.
        const regex = new RegExp(`\\b${mistake.original}\\b`, "gi");
        newHTML = newHTML.replace(regex, `<span class="grammar-mistake" data-suggestion="${mistake.suggestion}">${mistake.original}</span>`);
    });

    if (originalHTML !== newHTML) {
        element.innerHTML = newHTML;
        // Restore cursor position after update
        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(element);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }
}

// --- Main Logic ---
const processText = debounce((event) => {
    const element = event.target;
    const text = element.innerText;

    if (isChecking || !text) {
        return;
    }

    isChecking = true;
    console.log("Sending text to background for checking:", text);
    
    // Show a visual indicator that checking is in progress
    element.style.borderColor = '#f0ad4e';

    // Send text to the background script for AI processing
    chrome.runtime.sendMessage({ type: 'checkGrammar', text: text }, (response) => {
        console.log("Received corrections:", response.corrections);
        
        if (response && response.corrections && response.corrections.length > 0) {
            highlightMistakes(element, response.corrections);
        }
        
        // Reset visual indicator
        element.style.borderColor = '';
        isChecking = false;
    });

}, 2000); // Increased delay to 2 seconds

// Find all editable fields and attach our listener
function initializeListeners() {
    // We need to handle dynamically added elements as well
    const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === 1) { // ELEMENT_NODE
                    const editables = node.querySelectorAll('div[contenteditable="true"]');
                    editables.forEach(field => {
                        console.log("Grammar checker attached to a new element.");
                        field.addEventListener('keyup', processText);
                    });
                    if (node.isContentEditable) {
                         console.log("Grammar checker attached to a new element.");
                         node.addEventListener('keyup', processText);
                    }
                }
            });
        });
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Initial check for existing elements
    const initialEditables = document.querySelectorAll('div[contenteditable="true"]');
    initialEditables.forEach(field => {
        console.log("Grammar checker attached to an initial element.");
        field.addEventListener('keyup', processText);
    });
}

initializeListeners();
