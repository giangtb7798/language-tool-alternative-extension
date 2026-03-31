document.addEventListener('DOMContentLoaded', function() {
    const textInput = document.getElementById('textInput');
    const checkBtn = document.getElementById('checkBtn');
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
                'apiType', 'openaiApiKey', 'openaiModel',
                'localUrl', 'localModel', 'localApiKey',
                'language', 'customDictionary'
            ]);

            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            const response = await chrome.runtime.sendMessage({
                action: 'grammarCheck',
                text,
                settings,
                domain: tab?.url || ''
            });

            if (!response.success) throw new Error(response.error);
            renderResult(response.result, settings.customDictionary);

            chrome.runtime.sendMessage({
                action: 'saveHistory',
                entry: { type: 'grammar', input: text.substring(0, 500), output: response.result.substring(0, 1000) }
            });
        } catch (error) {
            showMessage('Error: ' + error.message, 'error');
        } finally {
            checkBtn.disabled = false;
            checkBtn.textContent = 'Check Grammar';
        }
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

        const isClean = result.toLowerCase().includes('no error') || result.includes('\u2713');
        let matches = Array.from(result.matchAll(/❌\s*"([^"]+)"\s*→\s*✅\s*"([^"]+)"/g));
        const reasons = Array.from(result.matchAll(/Reason:\s*(.+)/gi));

        if (dictionary && dictionary.length > 0) {
            const dictLower = dictionary.map(w => w.toLowerCase());
            matches = matches.filter(m => !dictLower.includes(m[1].toLowerCase()));
        }

        if ((isClean && matches.length === 0) || matches.length === 0) {
            resultsDiv.innerHTML = '<div class="result-card result-success">\u2713 No grammar errors found!</div>';
            return;
        }

        matches.forEach((m, i) => {
            const card = document.createElement('div');
            card.className = 'result-card result-error-item';
            let html = `
                <div class="error-line wrong">\u274C "${escapeHTML(m[1])}"</div>
                <div class="error-line correct">\u2705 "${escapeHTML(m[2])}"</div>
            `;
            if (reasons[i]) {
                html += `<div class="error-line reason">${escapeHTML(reasons[i][1])}</div>`;
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
