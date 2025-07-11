let isChecking = false;

// --- Tooltip Management ---
const tooltip = document.createElement('div');
tooltip.id = 'grammar-tooltip';
document.body.appendChild(tooltip);

function showTooltip(event) {
    const target = event.target;
    if (target.classList.contains('grammar-mistake')) {
        const suggestion = target.dataset.suggestion;
        tooltip.textContent = suggestion;

        const rect = target.getBoundingClientRect();

        // --- UPDATED POSITION CALCULATION ---
        // For absolute positioning, we need to add the scroll offset.
        const top = rect.top + window.scrollY - tooltip.offsetHeight - 32; // 32px buffer
        const left = rect.left + window.scrollX - 4; // 4px buffer

        tooltip.style.display = 'block';
        tooltip.style.top = `${top}px`;
        tooltip.style.left = `${left}px`;
        tooltip.style.opacity = '1';
    }
}

function hideTooltip() {
    tooltip.style.opacity = '0';
    setTimeout(() => {
        if (tooltip.style.opacity === '0') {
            tooltip.style.display = 'none';
        }
    }, 200);
}

// --- Click Handler for Replacing Text ---
function handleGrammarClick(event) {
    const target = event.target;
    if (target.classList.contains('grammar-mistake')) {
        event.preventDefault();
        event.stopPropagation();
        
        const suggestion = target.dataset.suggestion;
        const originalText = target.textContent;
        
        // Find the contenteditable parent
        const editableParent = target.closest('[contenteditable="true"]');
        if (!editableParent) return;
        
        // Save the current selection
        const selection = window.getSelection();
        const range = document.createRange();
        
        // Create a text node with the suggestion
        const suggestionNode = document.createTextNode(suggestion);
        
        // Replace the span with the suggestion text
        range.selectNode(target);
        range.deleteContents();
        range.insertNode(suggestionNode);
        
        // Position cursor after the replaced text
        range.setStartAfter(suggestionNode);
        range.setEndAfter(suggestionNode);
        selection.removeAllRanges();
        selection.addRange(range);
        
        // Focus the editable element to maintain cursor position
        editableParent.focus();
        
        // Hide tooltip after replacement
        hideTooltip();
    }
}

document.body.addEventListener('mouseover', showTooltip);
document.body.addEventListener('mouseout', hideTooltip);
document.body.addEventListener('click', handleGrammarClick);

function debounce(func, delay) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), delay);
    };
}

function highlightMistakes(element, mistakes) {
    let newHTML = element.innerHTML;
    const highlightedOriginals = new Set();

    mistakes.forEach(mistake => {
        if (!mistake.original || highlightedOriginals.has(mistake.original)) {
            return;
        }

        const regex = new RegExp(`\\b${mistake.original}\\b`, "gi");
        newHTML = newHTML.replace(regex,
            `<span class="grammar-mistake" data-suggestion="${mistake.suggestion}">${mistake.original}</span>`
        );
        highlightedOriginals.add(mistake.original);
    });

    element.innerHTML = newHTML;

    // Restore cursor to the end of the contenteditable div
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(element);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
}


const processText = debounce((event) => {
    const element = event.target;
    const text = element.innerText;

    if (isChecking || !text) return;

    isChecking = true;
    element.style.borderColor = '#f0ad4e';

    chrome.runtime.sendMessage({ type: 'checkGrammar', text: text }, (response) => {
        if (response && response.corrections && response.corrections.length > 0) {
            highlightMistakes(element, response.corrections);
        }
        element.style.borderColor = '';
        isChecking = false;
    });

}, 2000);

function initializeListeners() {
    const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType !== 1) return;
                const editables = node.querySelectorAll('div[contenteditable="true"]');
                editables.forEach(field => field.addEventListener('keyup', processText));
                if (node.isContentEditable) {
                    node.addEventListener('keyup', processText);
                }
            });
        });
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const initialEditables = document.querySelectorAll('div[contenteditable="true"]');
    initialEditables.forEach(field => field.addEventListener('keyup', processText));
}

initializeListeners();

