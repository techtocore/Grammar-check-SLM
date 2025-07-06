
// import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.6.1';
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1';


// Skip local model check, as we are loading from the web.
env.allowLocalModels = false;

// Use a class to ensure the model is loaded only once.
class CorrectionPipeline {
    static task = 'text2text-generation';
    static model = 'Xenova/flan-t5-small'; // A smaller, faster model good for grammar
    static instance = null;

    static async getInstance(progress_callback = null) {
        if (this.instance === null) {
            this.instance = pipeline(this.task, this.model, { progress_callback });
        }
        return this.instance;
    }
}

// Listen for messages from the content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("Received message in background script:", message);
    if (message.type === 'checkGrammar') {
        // Main logic
        (async () => {
            // 1. Get the pipeline instance
            // We're not passing a progress_callback here for simplicity,
            // but you could to update the UI with loading progress.
            const corrector = await CorrectionPipeline.getInstance();

            // 2. Construct a prompt for the model
            const prompt = `Correct the grammatical errors in this text: "${message.text}"`;

            // 3. Generate the correction
            const result = await corrector(prompt, {
                max_new_tokens: 100,
                temperature: 0.5,
                do_sample: true,
            });

            console.log("Correction result:", result);

            const correctedText = result[0].generated_text;
            
            // 4. For now, we're doing a simple diff. This is a placeholder for a more robust diffing algorithm.
            // This simple approach finds the first changed word.
            const originalWords = message.text.split(/\s+/);
            const correctedWords = correctedText.split(/\s+/);
            const mistakes = [];

            for (let i = 0; i < Math.min(originalWords.length, correctedWords.length); i++) {
                if(originalWords[i] !== correctedWords[i]) {
                     mistakes.push({ original: originalWords[i], suggestion: correctedWords[i] });
                     break; // Stop after the first mistake for this simple version.
                }
            }
            
            // 5. Send the result back to the content script
            console.log("Mistakes found:", mistakes);
            sendResponse({ corrections: mistakes });
        })();

        // Return true to indicate that we will send a response asynchronously
        return true;
    }
});

console.log("Grammar Check SLM background script loaded.");

