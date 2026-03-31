document.addEventListener('DOMContentLoaded', function() {
    const els = {
        apiType: document.getElementById('apiType'),
        apiKey: document.getElementById('apiKey'),
        model: document.getElementById('model'),
        localUrl: document.getElementById('localUrl'),
        localApiKey: document.getElementById('localApiKey'),
        localModel: document.getElementById('localModel'),
        autoCheck: document.getElementById('autoCheck'),
        checkInterval: document.getElementById('checkInterval'),
        language: document.getElementById('language'),
        saveBtn: document.getElementById('saveBtn'),
        testBtn: document.getElementById('testBtn'),
        status: document.getElementById('status'),
        openaiSettings: document.getElementById('openaiSettings'),
        customSettings: document.getElementById('customSettings'),
        domainInput: document.getElementById('domainInput'),
        addDomainBtn: document.getElementById('addDomainBtn'),
        domainList: document.getElementById('domainList'),
        domainHint: document.getElementById('domainHint'),
        dictInput: document.getElementById('dictInput'),
        addDictBtn: document.getElementById('addDictBtn'),
        dictList: document.getElementById('dictList'),
        dictHint: document.getElementById('dictHint'),
        clearHistoryBtn: document.getElementById('clearHistoryBtn'),
        historyInfo: document.getElementById('historyInfo')
    };

    const languagetoolSettings = document.getElementById('languagetoolSettings');
    const hybridSettings = document.getElementById('hybridSettings');
    const hybridLlmType = document.getElementById('hybridLlmType');

    // --- Provider toggle ---

    function updateProviderUI() {
        const type = els.apiType.value;
        hybridSettings.style.display = type === 'hybrid' ? 'block' : 'none';
        languagetoolSettings.style.display = type === 'languagetool' ? 'block' : 'none';

        const showOpenAI = type === 'openai' || (type === 'hybrid' && hybridLlmType.value === 'openai');
        const showCustom = type === 'local' || (type === 'hybrid' && hybridLlmType.value === 'local');

        els.openaiSettings.style.display = showOpenAI ? 'block' : 'none';
        els.customSettings.style.display = showCustom ? 'block' : 'none';
    }

    els.apiType.addEventListener('change', updateProviderUI);
    hybridLlmType.addEventListener('change', updateProviderUI);

    // --- Password toggles ---

    function setupPasswordToggle(btnId, input) {
        const btn = document.getElementById(btnId);
        btn.addEventListener('click', () => {
            const hidden = input.type === 'password';
            input.type = hidden ? 'text' : 'password';
            btn.textContent = hidden ? '🙈' : '👁';
        });
    }

    setupPasswordToggle('toggleApiKey', els.apiKey);
    setupPasswordToggle('toggleLocalKey', els.localApiKey);

    // --- Load settings ---

    chrome.storage.sync.get([
        'apiType', 'hybridLlmType', 'openaiApiKey', 'openaiModel',
        'localUrl', 'localModel', 'localApiKey',
        'autoCheck', 'checkInterval', 'language',
        'domainMode', 'domainList', 'customDictionary', 'clipboardMonitor'
    ], (result) => {
        if (result.apiType) els.apiType.value = result.apiType;
        if (result.hybridLlmType) hybridLlmType.value = result.hybridLlmType;
        if (result.openaiApiKey) els.apiKey.value = result.openaiApiKey;
        if (result.openaiModel) els.model.value = result.openaiModel;
        if (result.localUrl) els.localUrl.value = result.localUrl;
        if (result.localApiKey) els.localApiKey.value = result.localApiKey;
        if (result.localModel) els.localModel.value = result.localModel;
        els.autoCheck.checked = result.autoCheck !== false;
        document.getElementById('clipboardMonitor').checked = result.clipboardMonitor === true;
        els.checkInterval.value = result.checkInterval || 3;
        if (result.language) els.language.value = result.language;

        updateProviderUI();

        if (result.domainMode) {
            document.querySelector(`input[name="domainMode"][value="${result.domainMode}"]`).checked = true;
        }

        renderDomainTags(result.domainList || []);
        renderDictTags(result.customDictionary || []);
    });

    // --- Save settings ---

    els.saveBtn.addEventListener('click', () => {
        const type = els.apiType.value;
        const data = {
            apiType: type,
            autoCheck: els.autoCheck.checked,
            clipboardMonitor: document.getElementById('clipboardMonitor').checked,
            checkInterval: parseInt(els.checkInterval.value) || 3,
            language: els.language.value
        };

        const llmType = type === 'hybrid' ? hybridLlmType.value : type;
        if (type === 'hybrid') data.hybridLlmType = hybridLlmType.value;

        if (llmType === 'openai' && type !== 'languagetool') {
            const key = els.apiKey.value.trim();
            if (!key) return showStatus('Please enter an API key.', 'error');
            data.openaiApiKey = key;
            data.openaiModel = els.model.value;
        } else if (llmType === 'local' && type !== 'languagetool') {
            const url = els.localUrl.value.trim();
            const model = els.localModel.value.trim();
            if (!url) return showStatus('Please enter an API endpoint URL.', 'error');
            if (!model) return showStatus('Please enter a model name.', 'error');
            data.localUrl = url;
            data.localModel = model;
            data.localApiKey = els.localApiKey.value.trim();
        }

        chrome.storage.sync.set(data, () => showStatus('Settings saved!', 'success'));
    });

    // --- Test connection ---

    els.testBtn.addEventListener('click', async () => {
        els.testBtn.disabled = true;
        els.testBtn.textContent = 'Testing...';
        showStatus('Connecting...', 'success');

        const settings = {
            apiType: els.apiType.value,
            hybridLlmType: hybridLlmType.value,
            openaiApiKey: els.apiKey.value.trim(),
            openaiModel: els.model.value,
            localUrl: els.localUrl.value.trim(),
            localModel: els.localModel.value.trim(),
            localApiKey: els.localApiKey.value.trim()
        };

        try {
            const response = await chrome.runtime.sendMessage({ action: 'testConnection', settings });
            showStatus(
                response.success ? response.result : 'Failed: ' + response.error,
                response.success ? 'success' : 'error'
            );
        } catch (err) {
            showStatus('Test failed: ' + err.message, 'error');
        } finally {
            els.testBtn.disabled = false;
            els.testBtn.textContent = 'Test Connection';
        }
    });

    // --- Domain control ---

    let domainItems = [];

    function renderDomainTags(items) {
        domainItems = items;
        els.domainList.innerHTML = '';
        els.domainHint.style.display = items.length === 0 ? 'block' : 'none';

        items.forEach((domain, i) => {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.innerHTML = `${escapeHTML(domain)} <button class="tag-remove" data-idx="${i}">&times;</button>`;
            els.domainList.appendChild(tag);
        });

        els.domainList.querySelectorAll('.tag-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                domainItems.splice(parseInt(btn.dataset.idx), 1);
                saveDomainList();
                renderDomainTags(domainItems);
            });
        });
    }

    function saveDomainList() {
        const mode = document.querySelector('input[name="domainMode"]:checked').value;
        chrome.storage.sync.set({ domainMode: mode, domainList: domainItems });
    }

    els.addDomainBtn.addEventListener('click', () => {
        const val = els.domainInput.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (!val) return;
        if (domainItems.includes(val)) return;
        domainItems.push(val);
        saveDomainList();
        renderDomainTags(domainItems);
        els.domainInput.value = '';
    });

    els.domainInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') els.addDomainBtn.click();
    });

    document.querySelectorAll('input[name="domainMode"]').forEach(radio => {
        radio.addEventListener('change', saveDomainList);
    });

    // --- Custom dictionary ---

    let dictItems = [];

    function renderDictTags(items) {
        dictItems = items;
        els.dictList.innerHTML = '';
        els.dictHint.style.display = items.length === 0 ? 'block' : 'none';

        items.forEach((word, i) => {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.innerHTML = `${escapeHTML(word)} <button class="tag-remove" data-idx="${i}">&times;</button>`;
            els.dictList.appendChild(tag);
        });

        els.dictList.querySelectorAll('.tag-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                dictItems.splice(parseInt(btn.dataset.idx), 1);
                chrome.storage.sync.set({ customDictionary: dictItems });
                renderDictTags(dictItems);
            });
        });
    }

    els.addDictBtn.addEventListener('click', () => {
        const words = els.dictInput.value.split(',').map(w => w.trim()).filter(w => w && !dictItems.includes(w));
        if (words.length === 0) return;
        dictItems.push(...words);
        chrome.storage.sync.set({ customDictionary: dictItems });
        renderDictTags(dictItems);
        els.dictInput.value = '';
    });

    els.dictInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') els.addDictBtn.click();
    });

    // --- History ---

    chrome.runtime.sendMessage({ action: 'getHistory' }, (response) => {
        const count = response?.history?.length || 0;
        els.historyInfo.textContent = `${count} entries stored`;
    });

    els.clearHistoryBtn.addEventListener('click', async () => {
        if (!confirm('Clear all correction history?')) return;
        await chrome.runtime.sendMessage({ action: 'clearHistory' });
        els.historyInfo.textContent = '0 entries stored';
    });

    // --- Utilities ---

    function showStatus(message, type) {
        els.status.textContent = message;
        els.status.className = `status ${type}`;
        els.status.style.display = 'block';
        if (type === 'success') {
            setTimeout(() => { els.status.style.display = 'none'; }, 4000);
        }
    }

    function escapeHTML(str) {
        const el = document.createElement('span');
        el.textContent = str;
        return el.innerHTML;
    }
});
