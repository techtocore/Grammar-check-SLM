
// A simple debounce function to prevent firing on every keystroke
function debounce(func, delay) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), delay);
  };
}

// --- Placeholder for the actual AI check ---
// In the future, this will send text to background.js and get real suggestions.
// For now, it just simulates a response.
function getMockCorrections(text) {
  const mistakes = [];
  if (text.includes("teh")) {
    mistakes.push({ original: "teh", suggestion: "the" });
  }
  if (text.includes("wierd")) {
    mistakes.push({ original: "wierd", suggestion: "weird" });
  }
  return mistakes;
}


// --- UI Logic: Highlighting ---
// This function takes the results and highlights the mistakes on the page.
function highlightMistakes(element, mistakes) {
  let originalHTML = element.innerHTML;
  let newHTML = originalHTML;

  mistakes.forEach(mistake => {
    // Note: This is a simple regex that doesn't account for complex HTML tags.
    // It's good enough for a prototype!
    const regex = new RegExp(`\\b${mistake.original}\\b`, "gi");
    newHTML = newHTML.replace(regex, `<span class="grammar-mistake" data-suggestion="${mistake.suggestion}">${mistake.original}</span>`);
  });
  
  // Only update the DOM if changes were actually made to prevent cursor jumps
  if(originalHTML !== newHTML) {
    element.innerHTML = newHTML;
    
    // After updating innerHTML, we need to restore the cursor position.
    // This is a complex problem, but we can try a simple solution.
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(element);
    range.collapse(false); // false collapses to the end
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// --- Main Logic ---
const processText = debounce((event) => {
  const element = event.target;
  console.log("Checking text:", element.innerText);
  
  // 1. Get mock corrections
  const mistakes = getMockCorrections(element.innerText);
  
  // 2. If there are mistakes, highlight them
  if (mistakes.length > 0) {
    highlightMistakes(element, mistakes);
  }
}, 1000); // Wait 1 second after user stops typing


// Find all editable fields and attach our listener
function initializeListeners() {
    const editableFields = document.querySelectorAll('div[contenteditable="true"]');
    editableFields.forEach(field => {
        console.log("Grammar checker attached to an element.");
        field.addEventListener('keyup', processText);
    });
    
    // Note for your project: Textareas (<textarea>) are harder to work with
    // because you cannot put HTML (like our highlight span) inside them.
    // Professional tools use complex overlays to solve this. For a weekend
    // project, focusing on `contenteditable` divs is the best approach.
}

// Run the initialization
initializeListeners();

