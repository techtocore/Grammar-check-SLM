// background.js - Handles requests from the UI, runs the model, then sends back a response

import { pipeline } from '@huggingface/transformers';

// --- DEBUG KEEP-ALIVE ---
// This is a debugging utility to keep the service worker active.
// It's not strictly necessary for functionality but helps with inspection.
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
// Create the alarm when the extension is first installed or updated.
createKeepAlive();
// -------------------------


class CorrectionPipeline {
    static task = 'text-generation';
    static model = 'Xenova/tiny-random-Phi3ForCausalLM';
    static instance = null;

    static async getInstance() {
        if (this.instance === null) {
            console.log("BACKGROUND: Pipeline instance is null. Creating new one.");
            this.instance = await pipeline(this.task, this.model);
            console.log("BACKGROUND: New pipeline instance created successfully.");
        }
        return this.instance;
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'checkGrammar') {
        console.log("BACKGROUND: Received 'checkGrammar' message with text:", `"${message.text}"`);

        (async () => {
            try {
                const corrector = await CorrectionPipeline.getInstance();
                console.log("BACKGROUND: Got pipeline instance.");

                // Use the official chat template format for better reliability
                const messages = [
                    { role: 'user', content: `Analyze the grammatical errors in the following text. Respond with a single, valid JSON object containing an array called "corrections". Each object in the array must have two keys: "original" and "suggestion". Do not include any other text or explanation. If there are no errors, return an empty array. Text: "${message.text}"` },
                ];

                const prompt = corrector.tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true });
                console.log("BACKGROUND: Constructed prompt for the model.");

                const result = await corrector(prompt, {
                    max_new_tokens: 200,
                    temperature: 0.1,
                    top_k: 5,
                    do_sample: false,
                });
                const rawResponse = result[0].generated_text;
                console.log("BACKGROUND: Raw model output:", rawResponse);

                // --- Bulletproof JSON Parsing ---
                const startIndex = rawResponse.indexOf('{');
                const endIndex = rawResponse.lastIndexOf('}');
                let mistakes = [];

                if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
                    const jsonString = rawResponse.substring(startIndex, endIndex + 1);
                    console.log("BACKGROUND: Extracted potential JSON string:", jsonString);
                    try {
                        const parsedJson = JSON.parse(jsonString);
                        if (parsedJson.corrections && Array.isArray(parsedJson.corrections)) {
                            mistakes = parsedJson.corrections;
                            console.log("BACKGROUND: SUCCESS! Parsed corrections:", mistakes);
                        } else {
                            console.warn("BACKGROUND: Parsed JSON, but 'corrections' key is missing or not an array.", parsedJson);
                        }
                    } catch (e) {
                        console.error("BACKGROUND: CRITICAL - FAILED TO PARSE JSON.", e);
                        console.error("BACKGROUND: The string that failed was:", jsonString);
                    }
                } else {
                    console.warn("BACKGROUND: No valid JSON object found in the model's response.");
                }

                sendResponse({ corrections: mistakes });

            } catch (error) {
                console.error("BACKGROUND: An error occurred in the main grammar check pipeline:", error);
                sendResponse({ corrections: [] });
            }
        })();

        return true; // Keep the message channel open for the async response
    }
});

