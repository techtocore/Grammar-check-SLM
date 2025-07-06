// content-script.js - Using dynamic imports
class GrammarChecker {
    static instance = null;
    static model = 'Xenova/distilgpt2';
    static transformers = null;

    static async loadTransformers() {
        if (!this.transformers) {
            console.log("CONTENT: Loading transformers.js library...");
            this.transformers = await import('./transformers.js');
            this.transformers.env.allowLocalModels = false;
            console.log("CONTENT: Transformers.js loaded successfully.");
        }
        return this.transformers;
    }

    static async getInstance() {
        if (this.instance === null) {
            console.log("CONTENT: Creating new pipeline instance.");
            const { pipeline } = await this.loadTransformers();
            this.instance = await pipeline('text-generation', this.model);
            console.log("CONTENT: Pipeline created successfully.");
        }
        return this.instance;
    }

    static async checkGrammar(text) {
        try {
            const corrector = await this.getInstance();
            
            const messages = [
                { role: 'user', content: `Analyze the grammatical errors in the following text. Respond with a single, valid JSON object containing an array called "corrections". Each object in the array must have two keys: "original" and "suggestion". Do not include any other text or explanation. If there are no errors, return an empty array. Text: "${text}"` },
            ];

            const prompt = corrector.tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true });
            
            const result = await corrector(prompt, {
                max_new_tokens: 200,
                temperature: 0.1,
                top_k: 5,
                do_sample: false,
            });
            
            const rawResponse = result[0].generated_text;
            console.log("CONTENT: Raw model output:", rawResponse);
            
            // Parse JSON response
            const startIndex = rawResponse.indexOf('{');
            const endIndex = rawResponse.lastIndexOf('}');
            let corrections = [];

            if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
                const jsonString = rawResponse.substring(startIndex, endIndex + 1);
                console.log("CONTENT: Extracted JSON string:", jsonString);
                try {
                    const parsedJson = JSON.parse(jsonString);
                    if (parsedJson.corrections && Array.isArray(parsedJson.corrections)) {
                        corrections = parsedJson.corrections;
                        console.log("CONTENT: Parsed corrections:", corrections);
                    }
                } catch (e) {
                    console.error("CONTENT: Failed to parse JSON:", e);
                }
            }

            return corrections;
        } catch (error) {
            console.error("CONTENT: Grammar check failed:", error);
            return [];
        }
    }
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'checkGrammar') {
        console.log("CONTENT: Received grammar check request for text:", message.text);
        
        (async () => {
            try {
                const corrections = await GrammarChecker.checkGrammar(message.text);
                sendResponse({ corrections });
            } catch (error) {
                console.error("CONTENT: Error processing grammar check:", error);
                sendResponse({ corrections: [] });
            }
        })();
        
        return true; // Keep message channel open
    }
});

console.log("Grammar checker content script loaded with dynamic imports.");

let isChecking = false;

// A simple debounce function to prevent firing on every keystroke
function debounce(func, delay) {
    let timeout;
    return function (...args) {
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
}, 2000);

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

console.log("Grammar checker content script loaded.");