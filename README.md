# Grammar Checker Extension

A Chrome extension that checks grammar, rewrites text, detects tone, and translates — powered by OpenAI or any OpenAI-compatible LLM.

## Features

### Grammar Check
- AI-powered grammar and spelling checking
- Floating "Check Grammar" button on text selection
- Auto-check while typing (toggleable, configurable delay)
- Right-click context menu integration
- Keyboard shortcut: `Ctrl+Shift+G` (or `Cmd+Shift+G` on Mac)
- "Fix All" button to apply corrections directly
- Custom dictionary — words you add won't be flagged
- Context-aware feedback (adjusts for email, social media, etc.)

### Rewrite Mode
- Rewrite text in different styles: Formal, Casual, Concise, Friendly, Academic, Simple
- Copy or use rewritten text directly

### Tone Detector
- Analyzes the tone of your text (Professional, Casual, Aggressive, Sarcastic, etc.)
- Confidence level and analysis explanation
- Suggestions for tone improvement

### Translation + Grammar
- Translate between 12+ languages
- Auto-detect source language
- Grammar check on the translation

### Writing Statistics
- Live word count, sentence count, reading time
- Flesch-Kincaid readability score (Easy / Standard / Moderate / Complex)

### Side Panel
- Full-featured panel that stays open as you browse
- All modes accessible: Grammar, Rewrite, Tone, Translate
- Scan Page button to capture page text
- Correction history with timestamps

### Other
- Badge count on extension icon showing error count
- Domain allow/block list for auto-check control
- Works with OpenAI, Groq, OpenRouter, Together, Ollama, LM Studio, and any OpenAI-compatible API
- Multi-language support (13 languages + auto-detect)
- Secure settings with hidden API keys

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `language-tool-alternative-extension` folder

## Setup

### OpenAI
1. Click the extension icon → Settings
2. Select "OpenAI" as the provider
3. Enter your API key
4. Choose your model (GPT-4o recommended)
5. Save Settings

### Local LLM (Ollama / LM Studio)
1. Run your local server
2. In Settings, select "Custom API (OpenAI-compatible)"
3. Enter the endpoint URL and model name
4. Save Settings

### Cloud Providers (Groq, OpenRouter, Together, etc.)
1. In Settings, select "Custom API (OpenAI-compatible)"
2. Enter the provider's endpoint URL and your API key
3. Enter the model name
4. Save Settings

Common endpoints:
- Groq: `https://api.groq.com/openai/v1/chat/completions`
- OpenRouter: `https://openrouter.ai/api/v1/chat/completions`
- Together: `https://api.together.xyz/v1/chat/completions`
- Ollama: `http://localhost:11434/v1/chat/completions`
- LM Studio: `http://localhost:1234/v1/chat/completions`

## Usage

| Method | How |
|--------|-----|
| **Floating button** | Select text → click "Check Grammar" button |
| **Keyboard shortcut** | Select text → `Ctrl+Shift+G` |
| **Context menu** | Select text → right-click → "Check Grammar" |
| **Popup** | Click extension icon → type/paste → Check |
| **Side Panel** | Click "Open Full Panel" from popup |
| **Auto-check** | Type in any text field (when enabled) |

## Privacy

- API keys are stored locally in your browser
- Text goes only to the API provider you configure
- With local LLMs, all processing stays on your machine
- No data is collected by this extension

## License

Free to use and modify.
