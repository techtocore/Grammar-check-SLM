# Grammar Check SLM 🔍✍️

A prototype of a privacy-focused browser extension that provides real-time grammar checking using local AI models. No data leaves your browser - everything runs locally for maximum privacy and security.

![Extenstion pop-up](</assets/pop-up.png>)

## ✨ Features

- **🔒 Privacy-First**: All processing happens locally in your browser - no data is sent to external servers
- **🤖 AI-Powered**: Uses Hugging Face's Transformers.js with the FLAN-T5-Base model for intelligent grammar correction
- **⚡ Real-Time**: Instant grammar checking as you type in editable areas
- **🎨 Modern UI**: Beautiful, responsive popup interface with status indicators
- **🌐 Universal**: Works on all websites with editable content areas. Please note that the prototype does not support textarea elements yet.
- **📱 Lightweight**: Optimized for performance with progress tracking during model loading

## 🛠️ Technical Stack

- **Frontend**: HTML5, CSS3, JavaScript (ES6+)
- **Build Tool**: Webpack 5 with CSS loaders
- **AI Model**: Hugging Face Transformers.js (FLAN-T5-Base)
- **Extension API**: Chrome Extension Manifest V3
- **Architecture**: Service Worker background script + Content scripts

## 🚀 Getting Started

### Prerequisites
- Node.js (v14 or higher)
- npm or yarn
- Chrome/Chromium-based browser

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/techtocore/Grammar-check-SLM.git
   cd Grammar-check-SLM
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build the extension:**
   ```bash
   npm run build
   ```

4. **Load the extension in Chrome:**
   - Open `chrome://extensions/`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select the `build` directory
   - Click "Select Folder"

5. **Start using the extension:**
   - The extension icon will appear in your browser toolbar
   - Visit any webpage with editable content (class="editable-area")
   - Grammar mistakes will be highlighted automatically
   - Click on highlighted text to see suggestions

![Suggested correction](</assets/suggestion.png>)


## 📁 Project Structure

```
Grammar-check-SLM/
├── src/
│   ├── background.js      # Service worker with AI model
│   ├── content.js         # Content script for webpage interaction
│   ├── popup.html         # Extension popup interface
│   ├── popup.css          # Popup styling
│   ├── popup.js           # Popup functionality
│   └── style.css          # Content script styles
├── public/
│   ├── manifest.json      # Extension manifest
│   └── icons/             # Extension icons
├── build/                 # Built extension files
├── test.html             # Test page for development
├── webpack.config.js     # Webpack configuration
└── package.json          # Project dependencies
```

## 🧪 Development

### Development Mode
```bash
npm run dev
```
This starts Webpack in watch mode for automatic rebuilds during development.

### Testing
Use the included [`test.html`](/test.html) file in your browser after loading the extension

### Model Configuration
The extension currently uses `Xenova/FLAN-T5-Base` model. You can modify the model in `src/background.js`:
```javascript
static model = 'Xenova/FLAN-T5-Base'; // Change this to use a different model
```

## 🔧 Configuration

### Supported Models
- `Xenova/FLAN-T5-Base` (default) - Fast, lightweight
- `Xenova/t5-small` - Alternative option
- Any compatible Hugging Face model that supports text-to-text generation


## 🙏 Acknowledgments

- [Hugging Face](https://huggingface.co/) for Transformers.js and a [sample extension](https://github.com/huggingface/transformers.js/tree/main/examples/extension)
- [Google T5 Team](https://ai.googleblog.com/2020/02/exploring-transfer-learning-with-t5.html) for the T5 model architecture
- AI coding tools including GitHub Copilot, Gemini, and Claude.


## 📞 Support & 🤝 Contributions

If you encounter any issues or have questions:
- Check the browser console for error messages
- Ensure you have a stable internet connection for initial model download

Feel free to open an issue on [GitHub](https://github.com/techtocore/Grammar-check-SLM/issues) or submit a pull request with you feature additons.

---

**Made with ❤️ for privacy-conscious users**
