document.addEventListener('DOMContentLoaded', function() {
    const textInput = document.getElementById('textInput');
    const checkBtn = document.getElementById('checkBtn');
    const readBtn = document.getElementById('readBtn');
    const scanBtn = document.getElementById('scanBtn');
    const resultsDiv = document.getElementById('results');
    const autoToggle = document.getElementById('autoToggle');
    const optionsLink = document.getElementById('optionsLink');
    const openPanel = document.getElementById('openPanel');

    // --- Settings link ---
    optionsLink.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.openOptionsPage();
    });

    // --- Open side panel ---
    openPanel.addEventListener('click', async () => {
        try {
            const win = await chrome.windows.getCurrent();
            await chrome.sidePanel.open({ windowId: win.id });
            window.close();
        } catch (_) {
            chrome.runtime.openOptionsPage();
        }
    });

    // --- Auto-check toggle ---
    chrome.storage.sync.get(['autoCheck'], (result) => {
        autoToggle.checked = result.autoCheck !== false;
    });

    autoToggle.addEventListener('change', () => {
        chrome.storage.sync.set({ autoCheck: autoToggle.checked });
    });

    // --- Config check ---
    chrome.storage.sync.get(['apiType', 'openaiApiKey', 'localUrl', 'localModel'], (result) => {
        const apiType = result.apiType || 'openai';
        if (apiType === 'openai' && !result.openaiApiKey) {
            showMessage('Configure your API key in Settings.', 'error');
        } else if (apiType === 'local' && (!result.localUrl || !result.localModel)) {
            showMessage('Configure your API endpoint in Settings.', 'error');
        }
    });

    function streamGrammar(text, settings, domain) {
        return new Promise((resolve, reject) => {
            resultsDiv.style.display = 'block';
            resultsDiv.innerHTML = '';
            const card = document.createElement('div');
            card.className = 'result-card result-stream';
            const cursor = document.createElement('span');
            cursor.className = 'stream-cursor';
            card.appendChild(cursor);
            resultsDiv.appendChild(card);
            let fullText = '';
            let port;
            try { port = chrome.runtime.connect({ name: 'stream' }); }
            catch (e) { reject(e); return; }
            port.postMessage({ action: 'streamGrammarCheck', text, settings, domain });
            port.onMessage.addListener((msg) => {
                if (msg.type === 'chunk') {
                    fullText += msg.data || '';
                    card.textContent = fullText;
                    card.appendChild(cursor);
                } else if (msg.type === 'done') {
                    cursor.remove();
                    port.disconnect();
                    resolve(fullText || msg.data || '');
                } else if (msg.type === 'error') {
                    cursor.remove();
                    port.disconnect();
                    reject(new Error(msg.data));
                }
            });
            port.onDisconnect.addListener(() => {
                cursor.remove();
                if (fullText) resolve(fullText);
            });
        });
    }

    // --- Check grammar ---
    checkBtn.addEventListener('click', async () => {
        const text = textInput.value.trim();
        if (!text) {
            showMessage('Enter some text to check.', 'error');
            return;
        }

        checkBtn.disabled = true;
        checkBtn.textContent = 'Checking...';
        resultsDiv.style.display = 'block';
        resultsDiv.innerHTML = '<div class="result-card result-loading">Analyzing...</div>';

        try {
            const settings = await chrome.storage.sync.get([
                'apiType', 'hybridLlmType', 'openaiApiKey', 'openaiModel',
                'localUrl', 'localModel', 'localApiKey',
                'language', 'customDictionary', 'goalPreset', 'rateLimitPerMin'
            ]);

            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const domain = tab?.url || '';
            const apiType = settings.apiType || 'languagetool';
            let result;
            if (apiType === 'openai' || apiType === 'local') {
                try { result = await streamGrammar(text, settings, domain); }
                catch (_) { result = null; }
            }
            if (!result) {
                const response = await chrome.runtime.sendMessage({ action: 'grammarCheck', text, settings, domain });
                if (!response.success) throw new Error(response.error);
                result = response.result;
            }
            renderResult(result, settings.customDictionary);

            chrome.runtime.sendMessage({
                action: 'saveHistory',
                entry: { type: 'grammar', input: text.substring(0, 500), output: result.substring(0, 1000) }
            });
        } catch (error) {
            showMessage('Error: ' + error.message, 'error');
        } finally {
            checkBtn.disabled = false;
            checkBtn.textContent = 'Check Grammar';
        }
    });

    // --- Read aloud ---
    readBtn.addEventListener('click', async () => {
        const text = textInput.value.trim();
        if (!text) {
            showMessage('Enter some text to read.', 'error');
            return;
        }
        const settings = await chrome.storage.sync.get(['language', 'speakRate']);
        const result = GCSpeak.speak(text, {
            language: settings.language,
            rate: settings.speakRate,
            button: readBtn
        });
        if (!result.ok) showMessage(result.error, 'error');
    });

    // --- Scan page ---
    scanBtn.addEventListener('click', async () => {
        scanBtn.disabled = true;
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) throw new Error('No active tab');
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'getPageText' });
            if (response?.text) textInput.value = response.text;
        } catch (_) {
            showMessage('Could not scan page.', 'error');
        } finally {
            scanBtn.disabled = false;
        }
    });

    // --- Render ---
    function renderResult(result, dictionary) {
        resultsDiv.style.display = 'block';
        resultsDiv.innerHTML = '';

        const parsed = GrammarCore.parseGrammarResult(result, dictionary);

        if (parsed.isClean && parsed.errors.length === 0) {
            resultsDiv.innerHTML = '<div class="result-card result-success">\u2713 No grammar errors found!</div>';
            return;
        }

        parsed.errors.forEach((error) => {
            const card = document.createElement('div');
            card.className = 'result-card result-error-item';
            let html = `
                <div class="error-line wrong">\u274C "${escapeHTML(error.incorrect)}"</div>
                <div class="error-line correct">\u2705 "${escapeHTML(error.correct)}"</div>
            `;
            if (error.reason) {
                html += `<details class="error-why" open><summary>Why this fix?</summary><div>${escapeHTML(error.reason)}</div></details>`;
            }
            card.innerHTML = html;
            resultsDiv.appendChild(card);
        });
    }

    function showMessage(msg, type) {
        resultsDiv.style.display = 'block';
        const cls = type === 'error' ? 'result-error-msg' : 'result-success';
        resultsDiv.innerHTML = `<div class="result-card ${cls}">${escapeHTML(msg)}</div>`;
    }

    function escapeHTML(str) {
        const el = document.createElement('span');
        el.textContent = str;
        return el.innerHTML;
    }

    // --- Auto-fill from page ---
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]?.id) return;
        chrome.tabs.sendMessage(tabs[0].id, { action: 'checkGrammar' }, (response) => {
            if (chrome.runtime.lastError) return;
            if (response?.text) textInput.value = response.text;
        });
    });
});
