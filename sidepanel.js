// Side panel script v8.0.0

(function() {
    const textInput = document.getElementById('textInput');
    const actionBtn = document.getElementById('actionBtn');
    const scanBtn = document.getElementById('scanBtn');
    const resultsDiv = document.getElementById('results');
    const modeButtons = document.querySelectorAll('.mode-btn');

    const statWords = document.getElementById('statWords');
    const statSentences = document.getElementById('statSentences');
    const statReadTime = document.getElementById('statReadTime');
    const statReadability = document.getElementById('statReadability');

    const historyToggle = document.getElementById('historyToggle');
    const historyContent = document.getElementById('historyContent');
    const historyList = document.getElementById('historyList');
    const historyCount = document.getElementById('historyCount');
    const historyArrow = document.getElementById('historyArrow');

    const sessChecks = document.getElementById('sessChecks');
    const sessErrors = document.getElementById('sessErrors');
    const sessFixed = document.getElementById('sessFixed');

    let currentMode = 'grammar';
    let historyOpen = false;

    // --- Mode switching ---

    const MODE_LABELS = {
        grammar: 'Check Grammar',
        rewrite: 'Rewrite Text',
        rephrase: 'Get 3 Phrasings',
        tone: 'Analyze Tone',
        translate: 'Translate'
    };

    const OPTION_PANELS = {
        grammar: document.getElementById('optGrammar'),
        rewrite: document.getElementById('optRewrite'),
        rephrase: document.getElementById('optRephrase'),
        tone: document.getElementById('optTone'),
        translate: document.getElementById('optTranslate')
    };

    modeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            currentMode = btn.dataset.mode;
            modeButtons.forEach(b => b.classList.toggle('active', b === btn));
            Object.entries(OPTION_PANELS).forEach(([key, el]) => {
                el.classList.toggle('hidden', key !== currentMode);
            });
            actionBtn.textContent = MODE_LABELS[currentMode];
            resultsDiv.style.display = 'none';
        });
    });

    // --- Live stats ---

    textInput.addEventListener('input', updateStats);

    function updateStats() {
        const text = textInput.value;
        if (!text.trim()) {
            statWords.textContent = '0 words';
            statSentences.textContent = '0 sentences';
            statReadTime.textContent = '~0 min';
            statReadability.style.display = 'none';
            return;
        }
        const stats = calculateStats(text);
        statWords.textContent = `${stats.wordCount} words`;
        statSentences.textContent = `${stats.sentences} sentences`;
        statReadTime.textContent = `~${stats.readingTime} min`;
        statReadability.textContent = stats.readability.label;
        statReadability.style.display = 'inline';
        statReadability.style.background = stats.readability.color + '20';
        statReadability.style.color = stats.readability.color;
    }

    function calculateStats(text) {
        const words = text.trim().split(/\s+/).filter(w => w.length > 0);
        const wordCount = words.length;
        const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0).length || 1;
        const readingTime = Math.max(1, Math.ceil(wordCount / 200));

        let syllableCount = 0;
        words.forEach(word => {
            word = word.toLowerCase().replace(/[^a-z]/g, '');
            if (!word) return;
            if (word.length <= 3) { syllableCount += 1; return; }
            word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
            word = word.replace(/^y/, '');
            const m = word.match(/[aeiouy]{1,2}/g);
            syllableCount += m ? m.length : 1;
        });

        const flesch = 206.835 - 1.015 * (wordCount / sentences) - 84.6 * (syllableCount / Math.max(wordCount, 1));
        let readability;
        if (flesch >= 80)      readability = { label: 'Easy', color: '#27ae60' };
        else if (flesch >= 60) readability = { label: 'Standard', color: '#3498db' };
        else if (flesch >= 40) readability = { label: 'Moderate', color: '#f39c12' };
        else                   readability = { label: 'Complex', color: '#e74c3c' };

        return { wordCount, sentences, readingTime, readability };
    }

    // --- Session stats ---

    function refreshSessionStats() {
        chrome.runtime.sendMessage({ action: 'getSessionStats' }, (response) => {
            if (!response?.success) return;
            const s = response.stats;
            sessChecks.textContent = s.checksRun || 0;
            sessErrors.textContent = s.errorsFound || 0;
            sessFixed.textContent = s.errorsFixed || 0;
        });
    }

    refreshSessionStats();
    setInterval(refreshSessionStats, 5000);

    // --- Streaming via port ---

    function streamAction(action, text, settings, extraParams) {
        return new Promise((resolve, reject) => {
            resultsDiv.style.display = 'block';
            resultsDiv.innerHTML = '';

            const streamCard = document.createElement('div');
            streamCard.className = 'result-card result-stream';
            const cursor = document.createElement('span');
            cursor.className = 'stream-cursor';

            streamCard.appendChild(cursor);
            resultsDiv.appendChild(streamCard);

            let fullText = '';

            let port;
            try {
                port = chrome.runtime.connect({ name: 'stream' });
            } catch (e) {
                reject(new Error('Cannot connect to background: ' + e.message));
                return;
            }

            const [tab] = [];
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const domain = tabs[0]?.url || '';

                port.postMessage({
                    action,
                    text,
                    settings,
                    domain,
                    ...extraParams
                });
            });

            port.onMessage.addListener((msg) => {
                if (msg.type === 'chunk') {
                    fullText += msg.data;
                    // Update UI — insert text before cursor
                    streamCard.textContent = fullText;
                    streamCard.appendChild(cursor);
                    // Auto scroll
                    resultsDiv.scrollTop = resultsDiv.scrollHeight;
                } else if (msg.type === 'done') {
                    cursor.remove();
                    port.disconnect();
                    resolve(fullText);
                } else if (msg.type === 'error') {
                    cursor.remove();
                    port.disconnect();
                    reject(new Error(msg.data));
                }
            });

            port.onDisconnect.addListener(() => {
                cursor.remove();
                if (fullText) resolve(fullText); else reject(new Error('Disconnected'));
            });
        });
    }

    // --- Action button ---

    actionBtn.addEventListener('click', async () => {
        const text = textInput.value.trim();
        if (!text) {
            showMessage('Enter some text first.', 'error');
            return;
        }

        actionBtn.disabled = true;
        actionBtn.textContent = 'Working...';
        resultsDiv.style.display = 'block';
        resultsDiv.innerHTML = '<div class="result-card result-loading">Processing…</div>';

        try {
            const settings = await chrome.storage.sync.get([
                'apiType', 'openaiApiKey', 'openaiModel',
                'localUrl', 'localModel', 'localApiKey', 'language',
                'customDictionary'
            ]);

            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const domain = tab?.url || '';

            let response;

            switch (currentMode) {
                case 'grammar': {
                    // Use streaming for LLM, non-streaming for LanguageTool
                    const apiType = settings.apiType || 'languagetool';
                    if (apiType === 'openai' || apiType === 'local') {
                        try {
                            const result = await streamAction('streamGrammarCheck', text, settings, {});
                            renderGrammarResult(result, settings.customDictionary);
                            saveEntry('grammar', text, result);
                        } catch (err) {
                            // Fallback to non-streaming
                            response = await chrome.runtime.sendMessage({ action: 'grammarCheck', text, settings, domain });
                            if (response.success) {
                                renderGrammarResult(response.result, settings.customDictionary);
                                saveEntry('grammar', text, response.result);
                            }
                        }
                    } else {
                        response = await chrome.runtime.sendMessage({ action: 'grammarCheck', text, settings, domain });
                        if (response.success) {
                            renderGrammarResult(response.result, settings.customDictionary);
                            saveEntry('grammar', text, response.result);
                        }
                    }
                    break;
                }

                case 'rewrite':
                    response = await chrome.runtime.sendMessage({
                        action: 'rewriteText',
                        text,
                        style: document.getElementById('rewriteStyle').value,
                        settings
                    });
                    if (response.success) {
                        renderRewriteResult(response.result);
                        saveEntry('rewrite', text, response.result);
                    }
                    break;

                case 'rephrase':
                    response = await chrome.runtime.sendMessage({ action: 'rephraseText', text, settings });
                    if (response.success) {
                        renderRephraseResult(response.result);
                        saveEntry('rephrase', text, response.result);
                    }
                    break;

                case 'tone':
                    response = await chrome.runtime.sendMessage({ action: 'detectTone', text, settings });
                    if (response.success) {
                        renderToneResult(response.result);
                        saveEntry('tone', text, response.result);
                    }
                    break;

                case 'translate':
                    response = await chrome.runtime.sendMessage({
                        action: 'translateText',
                        text,
                        sourceLang: document.getElementById('translateFrom').value,
                        targetLang: document.getElementById('translateTo').value,
                        settings
                    });
                    if (response.success) {
                        renderTranslateResult(response.result);
                        saveEntry('translate', text, response.result);
                    }
                    break;
            }

            if (response && !response.success) throw new Error(response.error);

            // Refresh session stats after action
            setTimeout(refreshSessionStats, 500);

        } catch (err) {
            showMessage('Error: ' + err.message, 'error');
        } finally {
            actionBtn.disabled = false;
            actionBtn.textContent = MODE_LABELS[currentMode];
        }
    });

    // --- Scan page ---

    scanBtn.addEventListener('click', async () => {
        scanBtn.disabled = true;
        scanBtn.textContent = 'Scanning...';
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) throw new Error('No active tab');
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'getPageText' });
            if (!response?.text) throw new Error('No text found on page');
            textInput.value = response.text;
            updateStats();
        } catch (err) {
            showMessage('Scan failed: ' + err.message, 'error');
        } finally {
            scanBtn.disabled = false;
            scanBtn.textContent = 'Scan Page';
        }
    });

    // --- Renderers ---

    function escapeHTML(str) {
        const el = document.createElement('span');
        el.textContent = str;
        return el.innerHTML;
    }

    function renderGrammarResult(result, dictionary) {
        resultsDiv.style.display = 'block';
        resultsDiv.innerHTML = '';

        // Strip detected lang line if present
        const cleanResult = result.replace(/\[DETECTED_LANG:[^\]]+\]\n?/, '');

        const isClean = cleanResult.toLowerCase().includes('no error') || cleanResult.includes('✓');
        let matches = Array.from(cleanResult.matchAll(/❌\s*"([^"]+)"\s*→\s*✅\s*"([^"]+)"/g));
        const reasons = Array.from(cleanResult.matchAll(/Reason:\s*(.+)/gi));

        if (dictionary && dictionary.length > 0) {
            const dictLower = dictionary.map(w => w.toLowerCase());
            matches = matches.filter(m => !dictLower.includes(m[1].toLowerCase()));
        }

        if ((isClean && matches.length === 0) || matches.length === 0) {
            resultsDiv.innerHTML = '<div class="result-card result-success">✓ No grammar errors found!</div>';
            return;
        }

        matches.forEach((m, i) => {
            const card = document.createElement('div');
            card.className = 'result-card result-error-item';
            let html = `
                <div class="error-line wrong">❌ "${escapeHTML(m[1])}"</div>
                <div class="error-line correct">✅ "${escapeHTML(m[2])}"</div>
            `;
            if (reasons[i]) html += `<div class="error-line reason">${escapeHTML(reasons[i][1])}</div>`;
            card.innerHTML = html;
            resultsDiv.appendChild(card);
        });
    }

    function renderRewriteResult(result) {
        resultsDiv.style.display = 'block';
        resultsDiv.innerHTML = '';

        const card = document.createElement('div');
        card.className = 'result-card result-rewrite';
        card.textContent = result;

        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(result);
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        });

        const useBtn = document.createElement('button');
        useBtn.className = 'copy-btn';
        useBtn.textContent = 'Use this';
        useBtn.style.marginLeft = '6px';
        useBtn.addEventListener('click', () => {
            textInput.value = result;
            updateStats();
        });

        resultsDiv.appendChild(card);
        const btnRow = document.createElement('div');
        btnRow.style.marginBottom = '8px';
        btnRow.appendChild(copyBtn);
        btnRow.appendChild(useBtn);
        resultsDiv.appendChild(btnRow);
    }

    function renderRephraseResult(result) {
        resultsDiv.style.display = 'block';
        resultsDiv.innerHTML = '';

        // Parse numbered list: 1. ... 2. ... 3. ...
        const lines = result.split('\n').filter(l => /^\d+\./.test(l.trim()));
        if (lines.length === 0) {
            // Fallback: show raw
            const card = document.createElement('div');
            card.className = 'result-card result-raw';
            card.textContent = result;
            resultsDiv.appendChild(card);
            return;
        }

        const heading = document.createElement('div');
        heading.style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px;font-weight:600;';
        heading.textContent = 'Click to use an alternative phrasing:';
        resultsDiv.appendChild(heading);

        lines.forEach((line, i) => {
            const text = line.replace(/^\d+\.\s*/, '').trim();
            const card = document.createElement('div');
            card.className = 'result-rephrase-card';
            card.innerHTML = `<div class="rephrase-num">Option ${i + 1}</div><div class="rephrase-text">${escapeHTML(text)}</div>`;

            card.addEventListener('click', () => {
                textInput.value = text;
                updateStats();
                // Visual feedback
                card.style.borderColor = 'var(--green)';
                card.style.background = '#f0fdf4';
                setTimeout(() => {
                    card.style.borderColor = '';
                    card.style.background = '';
                }, 800);
            });

            const copyBtn = document.createElement('button');
            copyBtn.className = 'copy-btn';
            copyBtn.textContent = 'Copy';
            copyBtn.style.display = 'block';
            copyBtn.style.marginTop = '6px';
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(text);
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
            });
            card.appendChild(copyBtn);
            resultsDiv.appendChild(card);
        });
    }

    function renderToneResult(result) {
        resultsDiv.style.display = 'block';
        resultsDiv.innerHTML = '';

        const card = document.createElement('div');
        card.className = 'result-card result-tone';

        const toneMatch = result.match(/Tone:\s*(.+)/i);
        const confMatch = result.match(/Confidence:\s*(.+)/i);
        const analysisMatch = result.match(/Analysis:\s*(.+)/i);
        const suggestionMatch = result.match(/Suggestion:\s*(.+)/i);

        if (toneMatch) {
            const tone = toneMatch[1].trim();
            const toneColor = getToneColor(tone);
            let html = `<div class="tone-field"><span class="tone-badge" style="background:${toneColor}20;color:${toneColor};">${escapeHTML(tone)}</span></div>`;
            if (confMatch) html += `<div class="tone-field"><span class="tone-label">Confidence: </span><span class="tone-value">${escapeHTML(confMatch[1].trim())}</span></div>`;
            if (analysisMatch) html += `<div class="tone-field" style="margin-top:6px;">${escapeHTML(analysisMatch[1].trim())}</div>`;
            if (suggestionMatch && !suggestionMatch[1].toLowerCase().includes('none')) {
                html += `<div class="tone-field" style="margin-top:8px;padding:8px;background:var(--bg);border-radius:6px;font-size:12px;"><span class="tone-label">Tip: </span>${escapeHTML(suggestionMatch[1].trim())}</div>`;
            }
            card.innerHTML = html;
        } else {
            card.textContent = result;
        }

        resultsDiv.appendChild(card);
    }

    function getToneColor(tone) {
        const colors = {
            professional: '#2980b9', formal: '#2980b9',
            casual: '#27ae60', friendly: '#27ae60',
            enthusiastic: '#f39c12', persuasive: '#f39c12',
            aggressive: '#e74c3c', 'passive-aggressive': '#e74c3c',
            sarcastic: '#8e44ad', neutral: '#7f8c8d',
            empathetic: '#16a085', apologetic: '#16a085', assertive: '#d35400'
        };
        return colors[tone.toLowerCase()] || '#3498db';
    }

    function renderTranslateResult(result) {
        resultsDiv.style.display = 'block';
        resultsDiv.innerHTML = '';

        const translationMatch = result.match(/---\s*Translation\s*---\s*([\s\S]*?)(?=---\s*Grammar|$)/i);
        const grammarMatch = result.match(/---\s*Grammar\s*Check\s*---\s*([\s\S]*)/i);

        const card = document.createElement('div');
        card.className = 'result-card result-translate';
        let html = '';

        if (translationMatch) {
            const translation = translationMatch[1].trim();
            html += `<div class="translate-section">
                <div class="translate-heading">Translation</div>
                <div style="white-space:pre-wrap;color:var(--text);">${escapeHTML(translation)}</div>
                <button class="copy-btn" onclick="navigator.clipboard.writeText('${escapeHTML(translation).replace(/'/g, "\\'")}');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)">Copy</button>
            </div>`;
        }

        if (grammarMatch) {
            const grammar = grammarMatch[1].trim();
            html += `<div class="translate-section">
                <div class="translate-heading">Grammar Check</div>
                <div style="white-space:pre-wrap;color:var(--text);">${escapeHTML(grammar)}</div>
            </div>`;
        }

        if (!html) html = `<div style="white-space:pre-wrap;color:var(--text);">${escapeHTML(result)}</div>`;
        card.innerHTML = html;
        resultsDiv.appendChild(card);
    }

    function showMessage(msg, type) {
        resultsDiv.style.display = 'block';
        const cls = type === 'error' ? 'result-error-msg' : 'result-success';
        resultsDiv.innerHTML = `<div class="result-card ${cls}">${escapeHTML(msg)}</div>`;
    }

    // --- History ---

    function saveEntry(type, input, output) {
        chrome.runtime.sendMessage({
            action: 'saveHistory',
            entry: { type, input: input.substring(0, 500), output: output.substring(0, 1000) }
        });
        loadHistory();
    }

    historyToggle.addEventListener('click', () => {
        historyOpen = !historyOpen;
        historyContent.classList.toggle('hidden', !historyOpen);
        historyArrow.innerHTML = historyOpen ? '&#9650;' : '&#9660;';
        if (historyOpen) loadHistory();
    });

    async function loadHistory() {
        const response = await chrome.runtime.sendMessage({ action: 'getHistory' });
        const history = response?.history || [];

        historyCount.textContent = history.length > 0 ? `(${history.length})` : '';

        historyList.innerHTML = '';

        if (history.length === 0) {
            historyList.innerHTML = '<div class="history-empty">No history yet</div>';
            document.getElementById('chartSection').style.display = 'none';
            return;
        }

        // Action row (clear + export)
        const actionRow = document.createElement('div');
        actionRow.className = 'history-actions';

        const clearBtn = document.createElement('button');
        clearBtn.className = 'history-clear';
        clearBtn.textContent = 'Clear all';
        clearBtn.addEventListener('click', async () => {
            await chrome.runtime.sendMessage({ action: 'clearHistory' });
            loadHistory();
        });

        const exportJsonBtn = document.createElement('button');
        exportJsonBtn.className = 'history-export';
        exportJsonBtn.textContent = '↓ JSON';
        exportJsonBtn.addEventListener('click', () => exportHistory(history, 'json'));

        const exportCsvBtn = document.createElement('button');
        exportCsvBtn.className = 'history-export';
        exportCsvBtn.textContent = '↓ CSV';
        exportCsvBtn.addEventListener('click', () => exportHistory(history, 'csv'));

        actionRow.appendChild(clearBtn);
        actionRow.appendChild(exportJsonBtn);
        actionRow.appendChild(exportCsvBtn);
        historyList.appendChild(actionRow);

        history.slice(0, 50).forEach(item => {
            const el = document.createElement('div');
            el.className = 'history-item';
            const typeClass = `type-${item.type}`;
            el.innerHTML = `
                <div class="history-item-header">
                    <span class="history-item-type ${typeClass}">${item.type}</span>
                    <span>${formatTime(item.timestamp)}</span>
                </div>
                <div class="history-item-text">${escapeHTML(item.input)}</div>
            `;
            el.addEventListener('click', () => {
                textInput.value = item.input;
                updateStats();
                const modeBtn = document.querySelector(`[data-mode="${item.type}"]`);
                if (modeBtn) modeBtn.click();
            });
            historyList.appendChild(el);
        });

        // Render sparkline after list
        renderSparkline(history);
    }

    // --- Export history ---

    function exportHistory(history, format) {
        let content, filename, mime;

        if (format === 'json') {
            content = JSON.stringify(history, null, 2);
            filename = `grammar-history-${dateStr()}.json`;
            mime = 'application/json';
        } else {
            const headers = ['id', 'timestamp', 'type', 'input', 'output'];
            const rows = history.map(h => headers.map(k => `"${String(h[k] || '').replace(/"/g, '""')}"`).join(','));
            content = [headers.join(','), ...rows].join('\n');
            filename = `grammar-history-${dateStr()}.csv`;
            mime = 'text/csv';
        }

        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    function dateStr() {
        return new Date().toISOString().slice(0, 10);
    }

    // --- Sparkline chart ---

    function renderSparkline(history) {
        const chartSection = document.getElementById('chartSection');
        const canvas = document.getElementById('sparklineCanvas');

        // Build per-day error count for last 7 days
        const days = 7;
        const now = new Date();
        const buckets = Array.from({ length: days }, (_, i) => {
            const d = new Date(now);
            d.setDate(d.getDate() - (days - 1 - i));
            return { label: d.toLocaleDateString(undefined, { weekday: 'short' }), count: 0 };
        });

        history.forEach(item => {
            const dayAgo = Math.floor((Date.now() - item.timestamp) / 86400000);
            if (dayAgo < days && item.type === 'grammar') {
                const idx = days - 1 - dayAgo;
                // Count error markers in output
                const errCount = (item.output || '').split('❌').length - 1;
                buckets[idx].count += errCount;
            }
        });

        const maxVal = Math.max(...buckets.map(b => b.count), 1);
        chartSection.style.display = 'block';

        // Set canvas actual pixel dimensions
        const W = canvas.offsetWidth || 240;
        const H = 48;
        canvas.width = W;
        canvas.height = H;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);

        const pad = { l: 4, r: 4, t: 6, b: 18 };
        const chartW = W - pad.l - pad.r;
        const chartH = H - pad.t - pad.b;
        const barW = (chartW / days) * 0.6;
        const gap = chartW / days;

        // Detect dark mode
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const barColor = isDark ? '#5b9bd5' : '#3498db';
        const labelColor = isDark ? '#888ab0' : '#aaa';

        buckets.forEach((b, i) => {
            const x = pad.l + i * gap + (gap - barW) / 2;
            const barH = b.count === 0 ? 2 : Math.max(4, (b.count / maxVal) * chartH);
            const y = pad.t + chartH - barH;

            ctx.fillStyle = b.count === 0 ? (isDark ? '#333' : '#eee') : barColor;
            ctx.beginPath();
            ctx.roundRect(x, y, barW, barH, 2);
            ctx.fill();

            // Label
            ctx.fillStyle = labelColor;
            ctx.font = '8px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(b.label, x + barW / 2, H - 4);

            // Count label on top if non-zero
            if (b.count > 0) {
                ctx.fillStyle = barColor;
                ctx.font = 'bold 9px sans-serif';
                ctx.fillText(b.count, x + barW / 2, y - 2);
            }
        });
    }

    // --- Utilities ---

    function formatTime(ts) {
        const d = new Date(ts);
        const now = new Date();
        const diff = now - d;
        if (diff < 60000) return 'just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
        return d.toLocaleDateString();
    }

    // --- Init ---

    loadHistory();

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]?.id) return;
        chrome.tabs.sendMessage(tabs[0].id, { action: 'checkGrammar' }, (response) => {
            if (chrome.runtime.lastError) return;
            if (response?.text) {
                textInput.value = response.text;
                updateStats();
            }
        });
    });
})();
