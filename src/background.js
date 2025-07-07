// background.js - Handles requests from the UI, runs the model, then sends back a response

import { pipeline } from '@huggingface/transformers';

// --- DEBUG KEEP-ALIVE ---
const KEEP_ALIVE_ALARM = 'keep-alive-alarm';
chrome.alarms.get(KEEP_ALIVE_ALARM, (alarm) => {
    if (!alarm) {
        chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 0.5 });
    }
});
// -------------------------

class CorrectionPipeline {
    // Switched to a smaller, faster model optimized for this task.
    static task = 'text2text-generation';
    static model = 'Xenova/flan-t5-small';
    static instance = null;

    static async getInstance() {
        if (this.instance === null) {
            console.log("BACKGROUND: Pipeline instance is null. Creating a new one");

            // This callback will log progress to the console.
            const progress_callback = (data) => {
                if (data.status === 'progress') {
                    const progress = Math.round(data.progress);
                    if (progress % 10 === 0) {
                        console.log(`BACKGROUND: Loading ${data.file} - ${progress}%`);
                    }
                } else {
                    console.log("BACKGROUND:", data.status);
                }
            };

            this.instance = await pipeline(this.task, this.model, { progress_callback });
            console.log("BACKGROUND: New pipeline instance created successfully.");
        }
        return this.instance;
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'checkGrammar') {
        (async () => {
            try {
                const corrector = await CorrectionPipeline.getInstance();

                // A simple, direct prompt works best for T5 models.
                const prompt = `Correct this to standard English: "${message.text}"`;
                console.log("BACKGROUND: Constructed prompt:", prompt);

                const result = await corrector(prompt, { max_new_tokens: 100 });
                let correctedText = result[0].generated_text.trim();
                correctedText = correctedText.slice(1, -1); // Remove leading/trailing quotes
                console.log("BACKGROUND: Raw model output:", `"${correctedText}"`);

                const mistakes = [];
                // Use a regex that splits on spaces and punctuation, keeping the words.
                const originalWords = message.text.match(/\b\w+\b/g) || [];
                const correctedWords = correctedText.match(/\b\w+\b/g) || [];

                const originalSet = new Set(originalWords);
                const correctedSet = new Set(correctedWords);

                // Find words that were in the original but not the corrected version.
                const removedWords = originalWords.filter(word => !correctedSet.has(word));
                // Find words that are new in the corrected version.
                const addedWords = correctedWords.filter(word => !originalSet.has(word));

                console.log("BACKGROUND (Diff): Removed words:", removedWords);
                console.log("BACKGROUND (Diff): Added words:", addedWords);

                // Pair up the removed and added words to form corrections.
                const numMistakes = Math.min(removedWords.length, addedWords.length);
                for (let i = 0; i < numMistakes; i++) {
                    // To avoid flagging the same word multiple times if it appears more than once
                    // we should ensure we only add a mistake for a given original word once.
                    if (!mistakes.some(m => m.original === removedWords[i])) {
                        mistakes.push({
                            original: removedWords[i],
                            suggestion: addedWords[i]
                        });
                    }
                }

                console.log("BACKGROUND: Final paired mistakes:", mistakes);
                sendResponse({ corrections: mistakes });

            } catch (error) {
                console.error("BACKGROUND: An error occurred in the grammar check pipeline:", error);
                sendResponse({ corrections: [] });
            }
        })();
        return true;
    }
});