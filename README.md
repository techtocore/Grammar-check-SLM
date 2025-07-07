# Grammar Check SLM 🔍✍️

A prototype of a privacy-focused browser extension that provides real-time grammar checking using local AI models. No data leaves your browser - everything runs locally for maximum privacy and security.

## ✨ Features

- **🔒 Privacy-First**: All processing happens locally in your browser - no data is sent to external servers
- **🤖 AI-Powered**: Uses Hugging Face's Transformers.js with the FLAN-T5-Small model for intelligent grammar correction
- **⚡ Real-Time**: Instant grammar checking as you type in editable areas
- **🎨 Modern UI**: Beautiful, responsive popup interface with status indicators
- **🌐 Universal**: Works on all websites with editable content areas. Please note that the prototype does not support textarea elemenents yet.
- **📱 Lightweight**: Optimized for performance with progress tracking during model loading

## 🛠️ Technical Stack

- **Frontend**: HTML5, CSS3, JavaScript (ES6+)
- **Build Tool**: Webpack 5 with CSS loaders
- **AI Model**: Hugging Face Transformers.js (FLAN-T5-Small)
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
   - Visit any webpage with editable content
   - Grammar mistakes will be highlighted automatically
   - Click on highlighted text to see suggestions

## 🎯 How It Works

1. **Content Detection**: The extension automatically detects editable areas on web pages
2. **Text Analysis**: When you type, the text is analyzed by the local AI model
3. **Error Highlighting**: Grammar mistakes are highlighted with red underlines
4. **Suggestions**: Click on highlighted text to see correction suggestions
5. **Privacy**: All processing happens locally - no data leaves your browser

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
Use the included `test.html` file to test the extension:
```bash
# Open test.html in your browser after loading the extension
```

### Model Configuration
The extension currently uses `Xenova/flan-t5-small` model. You can modify the model in `src/background.js`:
```javascript
static model = 'Xenova/flan-t5-small'; // Change this to use a different model
```

## 🔧 Configuration

### Supported Models
- `Xenova/flan-t5-small` (default) - Fast, lightweight
- `Xenova/t5-small` - Alternative option
- Any compatible Hugging Face model that supports text-to-text generation

### Browser Compatibility
- ✅ Chrome (recommended)
- ✅ Microsoft Edge
- ✅ Brave
- ✅ Any Chromium-based browser

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Hugging Face](https://huggingface.co/) for Transformers.js
- [Google T5 Team](https://ai.googleblog.com/2020/02/exploring-transfer-learning-with-t5.html) for the T5 model architecture
- The open-source community for inspiration and tools

## 📞 Support

If you encounter any issues or have questions:
- Open an issue on [GitHub](https://github.com/techtocore/Grammar-check-SLM/issues)
- Check the browser console for error messages
- Ensure you have a stable internet connection for initial model download

---

**Made with ❤️ for privacy-conscious users**
