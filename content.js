// Grammar Checker Content Script v8.0.0
(function() {
    'use strict';

    console.log('[GrammarChecker] v8.0.0 loaded');

    // --- Runtime settings (reactive) ---
    const config = {
        autoCheck: true,
        checkInterval: 3000,
        apiType: 'languagetool',
        domainMode: 'blocklist',
        domainList: [],
        customDictionary: [],
        clipboardMonitor: false
    };

    function loadConfig() {
        chrome.storage.sync.get(
            ['autoCheck', 'checkInterval', 'apiType', 'domainMode', 'domainList', 'customDictionary', 'clipboardMonitor'],
            (r) => {
                config.autoCheck = r.autoCheck !== false;
                config.checkInterval = (r.checkInterval || 3) * 1000;
                config.apiType = r.apiType || 'languagetool';
                config.domainMode = r.domainMode || 'blocklist';
                config.domainList = r.domainList || [];
                config.customDictionary = r.customDictionary || [];
                config.clipboardMonitor = r.clipboardMonitor === true;
            }
        );
    }

    loadConfig();

    chrome.storage.onChanged.addListener((changes) => {
        if (changes.autoCheck !== undefined) config.autoCheck = changes.autoCheck.newValue !== false;
        if (changes.checkInterval !== undefined) config.checkInterval = (changes.checkInterval.newValue || 3) * 1000;
        if (changes.apiType) config.apiType = changes.apiType.newValue || 'languagetool';
        if (changes.domainMode) config.domainMode = changes.domainMode.newValue || 'blocklist';
        if (changes.domainList) config.domainList = changes.domainList.newValue || [];
        if (changes.customDictionary) config.customDictionary = changes.customDictionary.newValue || [];
        if (changes.clipboardMonitor !== undefined) config.clipboardMonitor = changes.clipboardMonitor.newValue === true;
    });

    function getEffectiveInterval() {
        if (config.apiType === 'languagetool') return Math.min(config.checkInterval, 1500);
        if (config.apiType === 'hybrid') return Math.min(config.checkInterval, 2000);
        return config.checkInterval;
    }

    // --- Domain check ---

    function isDomainAllowed() {
        if (config.domainList.length === 0) return true;
        const hostname = window.location.hostname;
        const match = config.domainList.some(d => hostname.includes(d));
        return config.domainMode === 'allowlist' ? match : !match;
    }

    function shouldAutoCheck() {
        return config.autoCheck && isDomainAllowed();
    }

    // --- State ---
    const state = {
        checkTimeout: null,
        scanTimeout: null,
        monitoredFields: new WeakMap(),
        activeIndicator: null,
        activeLoading: null,
        suppressUntil: 0,
        lastDetectedLang: null
    };

    // Global Escape key: dismiss popup and floating button
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            removeSelectionBtn();
            removeResultPopup();
        }
        // Ctrl+Shift+F — Fix All
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
            e.preventDefault();
            if (state.activeIndicator) {
                const { element, errorMap } = state.activeIndicator;
                if (element && errorMap) {
                    const matches = [];
                    errorMap.forEach((correct, incorrect) => matches.push([null, incorrect, correct]));
                    applyFixes(element, matches);
                    showToast('✅ All errors fixed!', 'success');
                    setTimeout(removeIndicator, 1000);
                }
            }
        }
    });

    // --- Inject stylesheet ---
    const sheet = document.createElement('style');
    sheet.textContent = `
        /* ---- Base variables ---- */
        .gc-root {
            --gc-blue: #3498db;
            --gc-blue-dark: #2980b9;
            --gc-green: #27ae60;
            --gc-green-dark: #219a52;
            --gc-red: #e74c3c;
            --gc-red-light: #fef2f2;
            --gc-red-text: #c0392b;
            --gc-bg: #ffffff;
            --gc-bg-alt: #f8f9fa;
            --gc-border: #3498db;
            --gc-text: #333333;
            --gc-text-muted: #666666;
            --gc-shadow: rgba(0,0,0,0.18);
            --gc-success-bg: #f0fdf4;
            --gc-success-text: #15803d;
        }
        @media (prefers-color-scheme: dark) {
            .gc-root {
                --gc-bg: #1e1e2e;
                --gc-bg-alt: #2a2a3e;
                --gc-border: #5b9bd5;
                --gc-text: #e0e0f0;
                --gc-text-muted: #a0a0c0;
                --gc-shadow: rgba(0,0,0,0.5);
                --gc-success-bg: #0d2b1a;
                --gc-success-text: #4ade80;
                --gc-red-light: #2b1010;
                --gc-red-text: #f87171;
            }
        }

        /* ---- Selection button ---- */
        .gc-selection-btn {
            position: fixed;
            background: var(--gc-blue, #3498db);
            color: white;
            padding: 6px 14px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
            cursor: pointer;
            z-index: 2147483647;
            box-shadow: 0 3px 12px rgba(0,0,0,0.25);
            user-select: none;
            pointer-events: auto;
            white-space: nowrap;
            transition: background 0.15s, transform 0.15s;
        }
        .gc-selection-btn:hover { background: #2980b9; }
        .gc-selection-btn.gc-loading {
            background: #7f8c8d;
            pointer-events: none;
        }

        /* ---- Result popup ---- */
        .gc-result-popup {
            position: fixed;
            background: var(--gc-bg, white);
            border: 2px solid var(--gc-border, #3498db);
            border-radius: 10px;
            padding: 16px;
            box-shadow: 0 8px 32px var(--gc-shadow, rgba(0,0,0,0.18));
            z-index: 2147483647;
            max-width: 420px;
            min-width: 280px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
            font-size: 13px;
            line-height: 1.5;
            color: var(--gc-text, #333);
            pointer-events: auto;
        }
        .gc-popup-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .gc-popup-title { font-weight: bold; color: var(--gc-blue, #3498db); }
        .gc-popup-title.gc-title-error { color: var(--gc-red, #e74c3c); }
        .gc-popup-close {
            cursor: pointer; font-size: 18px; color: #999;
            padding: 0 4px; background: none; border: none;
            line-height: 1;
        }
        .gc-popup-close:hover { color: #333; }
        .gc-success-msg {
            padding: 12px; background: var(--gc-success-bg, #f0fdf4);
            border-radius: 6px; color: var(--gc-success-text, #15803d);
            text-align: center; font-weight: 500;
        }
        .gc-error-msg {
            padding: 10px; background: var(--gc-red-light, #fef2f2);
            border-radius: 6px; color: var(--gc-red-text, #c0392b);
        }
        .gc-error-item {
            margin-bottom: 8px; padding: 10px;
            background: var(--gc-bg-alt, #f8f9fa); border-radius: 6px;
            border-left: 3px solid var(--gc-red, #e74c3c);
        }
        .gc-error-item .gc-wrong { color: var(--gc-red, #e74c3c); margin-bottom: 4px; }
        .gc-error-item .gc-correct { color: var(--gc-green, #27ae60); }
        .gc-error-item .gc-reason { color: var(--gc-text-muted, #666); font-size: 12px; font-style: italic; margin-top: 4px; }
        .gc-error-actions {
            display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap;
        }
        .gc-error-actions button {
            padding: 3px 10px; border: none; border-radius: 4px;
            font-size: 11px; cursor: pointer; font-weight: 600;
            transition: opacity 0.15s;
        }
        .gc-error-actions button:hover { opacity: 0.8; }
        .gc-btn-fix-one { background: var(--gc-green, #27ae60); color: white; }
        .gc-btn-ignore { background: #f0f0f0; color: #555; }
        .gc-btn-dict { background: var(--gc-blue, #3498db); color: white; }
        .gc-raw-result {
            padding: 10px; background: var(--gc-bg-alt, #f8f9fa);
            border-radius: 6px; white-space: pre-wrap;
            color: var(--gc-text, #333);
        }
        .gc-fix-btn {
            width: 100%; padding: 10px;
            background: var(--gc-green, #27ae60); color: white;
            border: none; border-radius: 6px;
            cursor: pointer; font-weight: bold;
            margin-top: 6px; font-size: 13px;
            transition: background 0.2s;
        }
        .gc-fix-btn:hover { background: var(--gc-green-dark, #219a52); }
        .gc-fix-btn.gc-fixed { background: #2ecc71; }

        /* ---- Indicator ---- */
        .gc-indicator {
            position: fixed;
            background: var(--gc-red, #e74c3c);
            color: white;
            padding: 5px 10px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: bold;
            z-index: 2147483647;
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
            user-select: none;
            pointer-events: auto;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .gc-indicator-lang {
            font-size: 13px;
            opacity: 0.9;
        }
        .gc-score-badge {
            position: fixed;
            padding: 3px 8px;
            border-radius: 10px;
            font-size: 11px;
            font-weight: bold;
            z-index: 2147483647;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
            pointer-events: none;
            user-select: none;
            box-shadow: 0 1px 4px rgba(0,0,0,0.2);
        }
        .gc-tooltip {
            position: fixed;
            background: var(--gc-bg, white);
            border: 2px solid var(--gc-red, #e74c3c);
            border-radius: 8px;
            padding: 12px;
            box-shadow: 0 4px 16px var(--gc-shadow, rgba(0,0,0,0.2));
            z-index: 2147483647;
            max-width: 350px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
            font-size: 13px;
            display: none;
            pointer-events: auto;
            color: var(--gc-text, #333);
        }
        .gc-tooltip-title {
            font-weight: bold; margin-bottom: 10px; color: var(--gc-red, #e74c3c);
            display: flex; justify-content: space-between; align-items: center;
        }
        .gc-shortcut-hint {
            font-size: 10px; color: var(--gc-text-muted, #888);
            font-weight: normal; font-family: monospace;
            background: var(--gc-bg-alt, #f0f0f0); padding: 1px 5px; border-radius: 3px;
        }

        /* ---- Loading indicator ---- */
        @keyframes gc-spin {
            to { transform: rotate(360deg); }
        }
        .gc-loading-indicator {
            position: fixed;
            display: flex;
            align-items: center;
            gap: 6px;
            background: #f0f4f8;
            border: 1px solid #cbd5e1;
            color: #64748b;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            z-index: 2147483647;
            pointer-events: none;
            box-shadow: 0 2px 6px rgba(0,0,0,0.1);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
            user-select: none;
            transition: opacity 0.2s;
        }
        .gc-loading-indicator .gc-spinner {
            width: 12px;
            height: 12px;
            border: 2px solid #cbd5e1;
            border-top-color: #3498db;
            border-radius: 50%;
            animation: gc-spin 0.6s linear infinite;
        }

        /* ---- Inline highlights ---- */
        .gc-inline-highlight {
            background: none !important;
            text-decoration: underline wavy #e74c3c !important;
            text-decoration-skip-ink: none !important;
            cursor: pointer !important;
            position: relative;
        }
        .gc-inline-bubble {
            position: fixed;
            background: var(--gc-bg, white);
            border: 1.5px solid var(--gc-red, #e74c3c);
            border-radius: 8px;
            padding: 8px 12px;
            font-size: 12px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
            box-shadow: 0 4px 14px rgba(0,0,0,0.15);
            z-index: 2147483647;
            pointer-events: auto;
            color: var(--gc-text, #333);
            min-width: 160px;
            display: flex;
            flex-direction: column;
            gap: 5px;
        }
        .gc-bubble-suggestion {
            color: var(--gc-green, #27ae60);
            font-weight: 600;
        }
        .gc-bubble-btns { display: flex; gap: 6px; }
        .gc-bubble-btns button {
            padding: 3px 10px; border: none; border-radius: 4px;
            font-size: 11px; cursor: pointer; font-weight: 600;
        }
        .gc-bubble-fix { background: var(--gc-green, #27ae60); color: white; }
        .gc-bubble-dismiss { background: #eee; color: #555; }

        /* ---- Toast notification ---- */
        .gc-toast {
            position: fixed;
            bottom: 24px;
            right: 24px;
            padding: 10px 18px;
            border-radius: 10px;
            font-size: 13px;
            font-weight: 600;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
            z-index: 2147483647;
            box-shadow: 0 4px 18px rgba(0,0,0,0.2);
            animation: gc-toast-in 0.25s ease;
            pointer-events: none;
            color: white;
        }
        .gc-toast.success { background: #27ae60; }
        .gc-toast.info { background: #3498db; }
        .gc-toast.warning { background: #f39c12; }
        @keyframes gc-toast-in {
            from { transform: translateY(16px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }
    `;
    (document.head || document.documentElement).appendChild(sheet);

    // Apply gc-root class to body for CSS variable scope
    document.addEventListener('DOMContentLoaded', () => {
        document.body.classList.add('gc-root');
    });
    if (document.body) document.body.classList.add('gc-root');

    // --- Toast ---

    function showToast(msg, type = 'info', duration = 3000) {
        const existing = document.querySelector('.gc-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `gc-toast ${type}`;
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), duration);
    }

    // --- Message handlers ---
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'checkGrammar') {
            const selected = window.getSelection().toString().trim();
            if (selected) {
                sendResponse({ text: selected });
                return;
            }
            const fields = document.querySelectorAll(
                'textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'
            );
            let allText = '';
            fields.forEach(el => {
                const t = getText(el);
                if (t) allText += t + '\n\n';
            });
            sendResponse({ text: allText.trim() || '' });
        }

        if (request.action === 'getSelectedText') {
            sendResponse({ text: window.getSelection().toString().trim() });
        }

        if (request.action === 'getPageText') {
            const text = (document.body.innerText || '').trim();
            sendResponse({ text: text.substring(0, 5000) });
        }

        if (request.action === 'showGrammarResult') {
            showContextMenuResult(request.text, request.result, request.error, null);
        }

        if (request.action === 'fixAll') {
            if (state.activeIndicator) {
                const { element, errorMap } = state.activeIndicator;
                if (element && errorMap) {
                    const matches = [];
                    errorMap.forEach((correct, incorrect) => matches.push([null, incorrect, correct]));
                    applyFixes(element, matches);
                    showToast('✅ All errors fixed!', 'success');
                    setTimeout(removeIndicator, 1000);
                }
            }
        }
        return true;
    });

    // --- Utility ---

    function escapeHTML(str) {
        const el = document.createElement('span');
        el.textContent = str;
        return el.innerHTML;
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function getText(element) {
        return (element.value || element.innerText || element.textContent || '').trim();
    }

    function isLexicalEditor(element) {
        return element.hasAttribute('data-lexical-editor') ||
               !!element.querySelector('[data-lexical-editor]') ||
               !!element.closest('[data-lexical-editor]');
    }

    function isCKEditor(element) {
        if (!element) return false;
        const check = (el) =>
            el.classList.contains('ck-content') ||
            el.classList.contains('ck-editor__editable') ||
            el.getAttribute('data-tid') === 'ckeditor' ||
            el.getAttribute('data-tid') === 'newMessageEditor';
        return check(element) ||
               !!element.querySelector('.ck-content') ||
               !!element.closest('.ck-content');
    }

    function selectAllContent(element) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function setTextCKEditor(element, text) {
        element.focus();
        selectAllContent(element);
        try {
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            const pasteEvent = new ClipboardEvent('paste', {
                bubbles: true, cancelable: true, clipboardData: dt
            });
            element.dispatchEvent(pasteEvent);
        } catch (_) {
            document.execCommand('insertText', false, text);
            element.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    function setText(element, text) {
        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
            element.focus();
            element.value = text;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }
        if (isCKEditor(element)) { setTextCKEditor(element, text); return; }
        element.focus();
        if (isLexicalEditor(element)) {
            selectAllContent(element);
            document.execCommand('insertText', false, text);
        } else {
            document.execCommand('selectAll');
            document.execCommand('delete');
            document.execCommand('insertText', false, text);
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // --- Parse detected language from result ---

    function extractDetectedLang(result) {
        const m = result.match(/\[DETECTED_LANG:([^:]+):([^:]+):([^\]]+)\]/);
        if (!m) return null;
        return { code: m[1], flag: m[2], name: m[3] };
    }

    function stripLangLine(result) {
        return result.replace(/\[DETECTED_LANG:[^\]]+\]\n?/, '');
    }

    function parseGrammarResult(result) {
        result = stripLangLine(result);

        let matches = Array.from(result.matchAll(/❌\s*"([^"]+)"\s*→\s*✅\s*"([^"]+)"/g));
        const reasons = Array.from(result.matchAll(/Reason:\s*(.+)/gi));

        if (config.customDictionary.length > 0) {
            const dictLower = config.customDictionary.map(w => w.toLowerCase());
            matches = matches.filter(m => !dictLower.includes(m[1].toLowerCase()));
        }

        const lower = result.toLowerCase();
        const hasExplicitClean = lower.includes('no error') || result.includes('✓') ||
            lower.includes('no issue') || lower.includes('no mistake') ||
            lower.includes('looks good') || lower.includes('grammatically correct') ||
            lower.includes('looks correct') || lower.includes('well-written');
        const hasNoErrorMarkers = matches.length === 0 && !result.includes('❌');
        const isClean = hasExplicitClean || hasNoErrorMarkers;

        return { isClean, matches, reasons, raw: result };
    }

    function applyFixes(element, matches) {
        // Remove highlights first so execCommand doesn't inherit the wavy underline style
        removeInlineHighlights(element);

        let text = getText(element);
        matches.forEach(m => {
            const startBound = /^\w/.test(m[1]) ? '\\b' : '(?<!\\w)';
            const endBound   = /\w$/.test(m[1]) ? '\\b' : '(?!\\w)';
            const exactRe = new RegExp(`${startBound}${escapeRegex(m[1])}${endBound}`, 'g');
            if (exactRe.test(text)) {
                text = text.replace(new RegExp(`${startBound}${escapeRegex(m[1])}${endBound}`, 'g'), m[2]);
            } else {
                text = text.replace(new RegExp(`${startBound}${escapeRegex(m[1])}${endBound}`, 'gi'), m[2]);
            }
            try {
                chrome.runtime.sendMessage({ action: 'logMistake', incorrect: m[1], correct: m[2] });
            } catch (_) {}
        });

        text = text.replace(/([,;:!?.])(\1)+/g, '$1');

        const fieldData = state.monitoredFields.get(element);
        if (fieldData) fieldData.lastChecked = text;
        state.suppressUntil = Date.now() + 2000;

        // Track fixes in session stats
        try {
            chrome.runtime.sendMessage({ action: 'incrementStat', key: 'errorsFixed', amount: matches.length });
        } catch (_) {}

        setText(element, text);
    }

    // --- Writing quality score ---

    function computeWritingScore(wordCount, errorCount) {
        if (wordCount === 0) return null;
        const errorRate = errorCount / Math.max(wordCount / 100, 1); // errors per 100 words
        if (errorRate === 0) return { grade: 'A', color: '#27ae60', label: 'Excellent' };
        if (errorRate <= 1) return { grade: 'B', color: '#2ecc71', label: 'Good' };
        if (errorRate <= 2.5) return { grade: 'C', color: '#f39c12', label: 'Fair' };
        if (errorRate <= 5) return { grade: 'D', color: '#e67e22', label: 'Poor' };
        return { grade: 'F', color: '#e74c3c', label: 'Needs Work' };
    }

    function showScoreBadge(element, errorCount) {
        removeScoreBadge();

        const text = getText(element);
        const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
        const score = computeWritingScore(wordCount, errorCount);
        if (!score) return;

        const badge = document.createElement('div');
        badge.className = 'gc-score-badge';
        badge.id = 'gc-score-badge';
        badge.textContent = score.grade;
        badge.title = `Writing Quality: ${score.label}`;
        badge.style.background = score.color;
        badge.style.color = 'white';

        const rect = element.getBoundingClientRect();
        badge.style.left = (rect.right + 8) + 'px';
        badge.style.top = (rect.top + 22) + 'px';  // slightly below indicator

        document.body.appendChild(badge);
    }

    function removeScoreBadge() {
        const b = document.getElementById('gc-score-badge');
        if (b) b.remove();
    }

    // --- Inline highlights (contenteditable only) ---

    const inlineHighlightMap = new WeakMap(); // element -> [{ span, incorrect, correct }]
    let activeBubble = null;

    function removeInlineBubble() {
        if (activeBubble) { activeBubble.remove(); activeBubble = null; }
    }

    function applyInlineHighlights(element, matches) {
        // Only works for contenteditable (not textarea — mirror technique too complex)
        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') return;

        removeInlineHighlights(element);

        const highlights = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) textNodes.push(node);

        matches.forEach(m => {
            const incorrect = m[1];
            const correct = m[2];

            for (const tn of textNodes) {
                const idx = tn.nodeValue.indexOf(incorrect);
                if (idx === -1) continue;

                try {
                    const range = document.createRange();
                    range.setStart(tn, idx);
                    range.setEnd(tn, idx + incorrect.length);

                    const span = document.createElement('span');
                    span.className = 'gc-inline-highlight';
                    span.dataset.incorrect = incorrect;
                    span.dataset.correct = correct;
                    range.surroundContents(span);

                    span.addEventListener('click', (e) => {
                        e.stopPropagation();
                        removeInlineBubble();
                        showInlineBubble(span, element, incorrect, correct);
                    });

                    highlights.push({ span, incorrect, correct });
                    break;
                } catch (_) {}
            }
        });

        if (highlights.length > 0) {
            inlineHighlightMap.set(element, highlights);
        }
    }

    function removeInlineHighlights(element) {
        removeInlineBubble();
        const existing = inlineHighlightMap.get(element);
        if (!existing) return;
        existing.forEach(({ span }) => {
            if (!span.parentNode) return;
            const text = document.createTextNode(span.textContent);
            span.parentNode.replaceChild(text, span);
        });
        inlineHighlightMap.delete(element);
    }

    function showInlineBubble(anchorSpan, element, incorrect, correct) {
        removeInlineBubble();

        const rect = anchorSpan.getBoundingClientRect();
        const bubble = document.createElement('div');
        bubble.className = 'gc-inline-bubble';
        bubble.innerHTML = `
            <div class="gc-bubble-suggestion">✅ "${escapeHTML(correct)}"</div>
            <div style="font-size:11px;color:#888;">instead of "${escapeHTML(incorrect)}"</div>
            <div class="gc-bubble-btns">
                <button class="gc-bubble-fix">Fix</button>
                <button class="gc-bubble-dismiss">Dismiss</button>
            </div>
        `;

        bubble.style.left = rect.left + 'px';
        bubble.style.top = (rect.bottom + 6) + 'px';
        document.body.appendChild(bubble);
        activeBubble = bubble;

        bubble.querySelector('.gc-bubble-fix').addEventListener('click', () => {
            applyFixes(element, [[null, incorrect, correct]]);
            removeInlineHighlights(element);
            removeInlineBubble();
        });
        bubble.querySelector('.gc-bubble-dismiss').addEventListener('click', removeInlineBubble);

        // Viewport clamp
        requestAnimationFrame(() => {
            const bRect = bubble.getBoundingClientRect();
            if (bRect.right > window.innerWidth - 8) {
                bubble.style.left = (window.innerWidth - bRect.width - 8) + 'px';
            }
            if (bRect.bottom > window.innerHeight - 8) {
                bubble.style.top = (rect.top - bRect.height - 6) + 'px';
            }
        });

        document.addEventListener('mousedown', function dismissBubble(e) {
            if (!bubble.contains(e.target) && e.target !== anchorSpan) {
                removeInlineBubble();
                document.removeEventListener('mousedown', dismissBubble);
            }
        });
    }

    // --- Add to dictionary ---

    function addToDictionary(word) {
        chrome.storage.sync.get(['customDictionary'], (r) => {
            const dict = r.customDictionary || [];
            if (!dict.map(w => w.toLowerCase()).includes(word.toLowerCase())) {
                dict.push(word);
                chrome.storage.sync.set({ customDictionary: dict }, () => {
                    config.customDictionary = dict;
                    showToast(`📖 "${word}" added to dictionary`, 'info');
                });
            } else {
                showToast(`"${word}" already in dictionary`, 'info');
            }
        });
    }

    // --- Selection floating button ---

    let selectionBtn = null;
    let selectionDebounce = null;

    function removeSelectionBtn() {
        if (selectionBtn) { selectionBtn.remove(); selectionBtn = null; }
    }

    function onSelectionChange() {
        clearTimeout(selectionDebounce);
        selectionDebounce = setTimeout(() => {
            const selection = window.getSelection();
            const text = selection.toString().trim();

            if (text.length < 3 || !selection.rangeCount) {
                removeSelectionBtn();
                return;
            }

            const anchor = selection.anchorNode;
            const anchorEl = anchor && (anchor.nodeType === 3 ? anchor.parentElement : anchor);
            if (anchorEl && (anchorEl.closest('.gc-selection-btn') || anchorEl.closest('.gc-result-popup'))) return;

            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return;

            removeSelectionBtn();

            const btn = document.createElement('div');
            btn.className = 'gc-selection-btn';
            btn.textContent = '✓ Check Grammar';

            let left = rect.left + (rect.width / 2);
            let top = rect.top - 36;
            if (top < 8) top = rect.bottom + 8;

            btn.style.left = left + 'px';
            btn.style.top = top + 'px';
            btn.style.transform = 'translateX(-50%)';

            btn.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();

                btn.textContent = '⏳ Checking...';
                btn.classList.add('gc-loading');

                const selectedText = text;
                const editableEl = findEditableAncestor(selection.anchorNode);

                chrome.storage.sync.get(
                    ['apiType', 'hybridLlmType', 'openaiApiKey', 'openaiModel', 'localUrl', 'localModel', 'localApiKey', 'language'],
                    (settings) => {
                        chrome.runtime.sendMessage(
                            { action: 'grammarCheck', text: selectedText, settings, domain: window.location.href },
                            (response) => {
                                removeSelectionBtn();
                                if (response && response.success) {
                                    showContextMenuResult(selectedText, response.result, null, editableEl);
                                } else {
                                    showContextMenuResult(selectedText, null, response?.error || 'Unknown error', null);
                                }
                            }
                        );
                    }
                );
            });

            document.body.appendChild(btn);
            selectionBtn = btn;

            requestAnimationFrame(() => {
                const bRect = btn.getBoundingClientRect();
                let adjustedLeft = left;
                if (bRect.right > window.innerWidth - 8) adjustedLeft = window.innerWidth - bRect.width / 2 - 8;
                if (bRect.left < 8) adjustedLeft = bRect.width / 2 + 8;
                btn.style.left = adjustedLeft + 'px';
            });
        }, 300);
    }

    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mousedown', (e) => {
        if (selectionBtn && !selectionBtn.contains(e.target)) removeSelectionBtn();
    });

    // --- Result popup ---

    let activeResultPopup = null;

    function removeResultPopup() {
        if (activeResultPopup) { activeResultPopup.remove(); activeResultPopup = null; }
    }

    function findEditableAncestor(node) {
        let el = node && node.nodeType === 3 ? node.parentElement : node;
        while (el && el !== document.body) {
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el;
            if (el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') return el;
            el = el.parentElement;
        }
        return null;
    }

    function showContextMenuResult(originalText, result, error, preResolvedEditable) {
        removeResultPopup();

        const selection = window.getSelection();
        let anchorRect = null;
        let editableEl = preResolvedEditable || null;

        if (selection.rangeCount > 0) {
            anchorRect = selection.getRangeAt(0).getBoundingClientRect();
            if (!editableEl) editableEl = findEditableAncestor(selection.anchorNode);
        }

        const popup = document.createElement('div');
        popup.className = 'gc-result-popup gc-root';

        if (error) {
            popup.innerHTML = `
                <div class="gc-popup-header">
                    <span class="gc-popup-title gc-title-error">Grammar Check Error</span>
                    <button class="gc-popup-close">&times;</button>
                </div>
                <div class="gc-error-msg">${escapeHTML(error)}</div>
            `;
        } else {
            const langInfo = extractDetectedLang(result);
            const parsed = parseGrammarResult(result);
            let bodyHTML = '';

            const titleExtra = langInfo
                ? ` <span style="font-size:14px;font-weight:normal;">${langInfo.flag} ${langInfo.name}</span>`
                : '';

            if (parsed.isClean && parsed.matches.length === 0) {
                bodyHTML = '<div class="gc-success-msg">✓ No grammar errors found!</div>';
            } else if (parsed.matches.length > 0) {
                parsed.matches.forEach((m, i) => {
                    const incorrect = m[1];
                    const correct = m[2];
                    const reason = parsed.reasons[i] ? parsed.reasons[i][1] : '';
                    bodyHTML += `<div class="gc-error-item" data-idx="${i}">
                        <div class="gc-wrong">❌ "${escapeHTML(incorrect)}"</div>
                        <div class="gc-correct">✅ "${escapeHTML(correct)}"</div>
                        ${reason ? `<div class="gc-reason">${escapeHTML(reason)}</div>` : ''}
                        <div class="gc-error-actions">
                            ${editableEl ? `<button class="gc-btn-fix-one" data-incorrect="${escapeHTML(incorrect)}" data-correct="${escapeHTML(correct)}">Fix</button>` : ''}
                            <button class="gc-btn-ignore" data-idx="${i}">Ignore</button>
                            <button class="gc-btn-dict" data-word="${escapeHTML(incorrect)}">Add to Dict</button>
                        </div>
                    </div>`;
                });

                if (editableEl) {
                    bodyHTML += '<button class="gc-fix-btn">Fix All</button>';
                }
            } else {
                bodyHTML = `<div class="gc-raw-result">${escapeHTML(result)}</div>`;
            }

            popup.innerHTML = `
                <div class="gc-popup-header">
                    <span class="gc-popup-title">Grammar Check${titleExtra}</span>
                    <button class="gc-popup-close">&times;</button>
                </div>
                ${bodyHTML}
            `;

            // Fix All
            const fixAllBtn = popup.querySelector('.gc-fix-btn');
            if (fixAllBtn && editableEl) {
                fixAllBtn.addEventListener('click', () => {
                    applyFixes(editableEl, parsed.matches);
                    fixAllBtn.textContent = '✓ Fixed!';
                    fixAllBtn.classList.add('gc-fixed');
                    setTimeout(removeResultPopup, 800);
                });
            }

            // Individual fix buttons
            popup.querySelectorAll('.gc-btn-fix-one').forEach(btn => {
                btn.addEventListener('click', () => {
                    const inc = btn.dataset.incorrect;
                    const cor = btn.dataset.correct;
                    if (editableEl) applyFixes(editableEl, [[null, inc, cor]]);
                    // Hide this error item
                    const item = btn.closest('.gc-error-item');
                    if (item) item.style.opacity = '0.4';
                    btn.textContent = '✓';
                    btn.disabled = true;
                });
            });

            // Ignore buttons
            popup.querySelectorAll('.gc-btn-ignore').forEach(btn => {
                btn.addEventListener('click', () => {
                    const item = btn.closest('.gc-error-item');
                    if (item) item.remove();
                    // If no items left, close popup
                    if (!popup.querySelector('.gc-error-item')) removeResultPopup();
                });
            });

            // Add to dictionary buttons
            popup.querySelectorAll('.gc-btn-dict').forEach(btn => {
                btn.addEventListener('click', () => {
                    const word = btn.dataset.word;
                    addToDictionary(word);
                    const item = btn.closest('.gc-error-item');
                    if (item) item.style.opacity = '0.4';
                    btn.textContent = '✓ Added';
                    btn.disabled = true;
                });
            });
        }

        popup.querySelector('.gc-popup-close').addEventListener('click', removeResultPopup);

        document.body.appendChild(popup);
        activeResultPopup = popup;

        requestAnimationFrame(() => {
            const pRect = popup.getBoundingClientRect();
            let left, top;

            if (anchorRect && anchorRect.width > 0) {
                left = anchorRect.left + (anchorRect.width / 2) - (pRect.width / 2);
                top = anchorRect.bottom + 8;
            } else {
                left = (window.innerWidth - pRect.width) / 2;
                top = (window.innerHeight - pRect.height) / 2;
            }

            if (left + pRect.width > window.innerWidth - 10) left = window.innerWidth - pRect.width - 10;
            if (left < 10) left = 10;
            if (top + pRect.height > window.innerHeight - 10) top = anchorRect ? anchorRect.top - pRect.height - 8 : 10;
            if (top < 10) top = 10;

            popup.style.left = left + 'px';
            popup.style.top = top + 'px';
        });

        document.addEventListener('mousedown', function dismissOnClick(e) {
            if (!popup.contains(e.target)) {
                removeResultPopup();
                document.removeEventListener('mousedown', dismissOnClick);
            }
        });
    }

    // --- Indicator with proper cleanup ---

    function showIndicator(element, errorMap, detectedLang) {
        removeIndicator();

        const indicator = document.createElement('div');
        indicator.className = 'gc-indicator';

        let langSpan = '';
        if (detectedLang) {
            state.lastDetectedLang = detectedLang;
            langSpan = `<span class="gc-indicator-lang" title="${detectedLang.name}">${detectedLang.flag}</span>`;
        }
        indicator.innerHTML = `${langSpan}<span>${errorMap.size} error${errorMap.size > 1 ? 's' : ''}</span>`;

        const rect = element.getBoundingClientRect();
        indicator.style.left = (rect.right + 8) + 'px';
        indicator.style.top = rect.top + 'px';

        const tooltip = document.createElement('div');
        tooltip.className = 'gc-tooltip gc-root';

        let html = `<div class="gc-tooltip-title">
            Grammar Issues:
            <span class="gc-shortcut-hint">Ctrl+Shift+F = Fix All</span>
        </div>`;
        errorMap.forEach((correct, incorrect) => {
            html += `<div class="gc-error-item">
                <div class="gc-wrong">❌ "${escapeHTML(incorrect)}"</div>
                <div class="gc-correct">✅ "${escapeHTML(correct)}"</div>
            </div>`;
        });
        html += '<button class="gc-fix-btn">Fix All</button>';
        tooltip.innerHTML = html;

        let hideTimeout;

        const onIndicatorEnter = () => {
            clearTimeout(hideTimeout);
            tooltip.style.display = 'block';
            const iRect = indicator.getBoundingClientRect();
            let left = iRect.left;
            let top = iRect.bottom + 8;
            tooltip.style.left = left + 'px';
            tooltip.style.top = top + 'px';

            const tRect = tooltip.getBoundingClientRect();
            if (tRect.right > window.innerWidth) left = window.innerWidth - tRect.width - 10;
            if (left < 10) left = 10;
            if (tRect.bottom > window.innerHeight) top = iRect.top - tRect.height - 8;
            if (top < 10) top = 10;
            tooltip.style.left = left + 'px';
            tooltip.style.top = top + 'px';
        };

        const onIndicatorLeave = () => {
            hideTimeout = setTimeout(() => {
                if (!tooltip.matches(':hover')) tooltip.style.display = 'none';
            }, 200);
        };

        indicator.addEventListener('mouseenter', onIndicatorEnter);
        indicator.addEventListener('mouseleave', onIndicatorLeave);
        tooltip.addEventListener('mouseenter', () => clearTimeout(hideTimeout));
        tooltip.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });

        tooltip.querySelector('.gc-fix-btn').addEventListener('click', () => {
            const matches = [];
            errorMap.forEach((correct, incorrect) => matches.push([null, incorrect, correct]));
            applyFixes(element, matches);
            const btn = tooltip.querySelector('.gc-fix-btn');
            btn.textContent = '✓ Fixed!';
            btn.classList.add('gc-fixed');
            setTimeout(removeIndicator, 1000);
        });

        document.body.appendChild(indicator);
        document.body.appendChild(tooltip);

        const updatePosition = () => {
            if (!document.body.contains(element)) { removeIndicator(); return; }
            const r = element.getBoundingClientRect();
            indicator.style.left = (r.right + 8) + 'px';
            indicator.style.top = r.top + 'px';
            const scoreBadge = document.getElementById('gc-score-badge');
            if (scoreBadge) {
                scoreBadge.style.left = (r.right + 8) + 'px';
                scoreBadge.style.top = (r.top + 26) + 'px';
            }
        };

        window.addEventListener('scroll', updatePosition, { passive: true });
        window.addEventListener('resize', updatePosition, { passive: true });

        state.activeIndicator = {
            indicator, tooltip, element, errorMap,
            cleanup: () => {
                window.removeEventListener('scroll', updatePosition);
                window.removeEventListener('resize', updatePosition);
            }
        };
    }

    function removeIndicator() {
        if (!state.activeIndicator) return;
        state.activeIndicator.cleanup();
        state.activeIndicator.indicator.remove();
        state.activeIndicator.tooltip.remove();
        state.activeIndicator = null;
        removeScoreBadge();
    }

    // --- Loading indicator ---

    function showLoadingIndicator(element) {
        removeLoadingIndicator();

        const loader = document.createElement('div');
        loader.className = 'gc-loading-indicator';
        loader.innerHTML = '<div class="gc-spinner"></div>Checking…';

        const rect = element.getBoundingClientRect();
        loader.style.left = (rect.right + 8) + 'px';
        loader.style.top = rect.top + 'px';

        document.body.appendChild(loader);

        const updatePosition = () => {
            if (!document.body.contains(element)) { removeLoadingIndicator(); return; }
            const r = element.getBoundingClientRect();
            loader.style.left = (r.right + 8) + 'px';
            loader.style.top = r.top + 'px';
        };

        window.addEventListener('scroll', updatePosition, { passive: true });
        window.addEventListener('resize', updatePosition, { passive: true });

        state.activeLoading = {
            loader,
            cleanup: () => {
                window.removeEventListener('scroll', updatePosition);
                window.removeEventListener('resize', updatePosition);
            }
        };
    }

    function removeLoadingIndicator() {
        if (!state.activeLoading) return;
        state.activeLoading.cleanup();
        state.activeLoading.loader.remove();
        state.activeLoading = null;
    }

    // --- Grammar check via background ---

    async function checkGrammar(text, element) {
        showLoadingIndicator(element);
        try {
            const settings = await chrome.storage.sync.get([
                'apiType', 'hybridLlmType', 'openaiApiKey', 'openaiModel',
                'localUrl', 'localModel', 'localApiKey', 'language'
            ]);

            const response = await chrome.runtime.sendMessage({
                action: 'grammarCheck',
                text,
                settings,
                domain: window.location.href
            });

            removeLoadingIndicator();

            if (!response.success) {
                console.error('[GrammarChecker] API error:', response.error);
                return;
            }

            // Extract detected language info
            const detectedLang = extractDetectedLang(response.result);
            const parsed = parseGrammarResult(response.result);

            if (parsed.isClean || parsed.matches.length === 0) {
                if (state.activeIndicator?.element === element) removeIndicator();
                updateBadge(0);
                return;
            }

            const errorMap = new Map();
            parsed.matches.forEach(m => errorMap.set(m[1], m[2]));
            showIndicator(element, errorMap, detectedLang);
            showScoreBadge(element, errorMap.size);
            applyInlineHighlights(element, parsed.matches);
            updateBadge(errorMap.size);
        } catch (error) {
            removeLoadingIndicator();
            console.error('[GrammarChecker] Check failed:', error);
        }
    }

    function updateBadge(count) {
        try { chrome.runtime.sendMessage({ action: 'updateBadge', count }); } catch (_) {}
    }

    // --- Clipboard monitor ---

    let clipboardCheckTimeout = null;

    document.addEventListener('copy', () => {
        if (!config.clipboardMonitor) return;
        clearTimeout(clipboardCheckTimeout);
        clipboardCheckTimeout = setTimeout(async () => {
            try {
                const text = await navigator.clipboard.readText();
                if (!text || text.trim().length < 20) return;

                const settings = await chrome.storage.sync.get([
                    'apiType', 'hybridLlmType', 'openaiApiKey', 'openaiModel',
                    'localUrl', 'localModel', 'localApiKey', 'language'
                ]);

                const response = await chrome.runtime.sendMessage({
                    action: 'clipboardCheck',
                    text: text.trim(),
                    settings,
                    domain: window.location.href
                });

                if (!response?.success) return;

                const parsed = parseGrammarResult(response.result);
                if (parsed.isClean && parsed.matches.length === 0) {
                    showToast('✓ Copied text looks good!', 'success', 2500);
                } else if (parsed.matches.length > 0) {
                    showToast(`⚠️ ${parsed.matches.length} grammar issue${parsed.matches.length > 1 ? 's' : ''} in copied text`, 'warning', 4000);
                }
            } catch (_) {}
        }, 500);
    });

    // --- Field monitoring ---

    function attachToField(element) {
        if (state.monitoredFields.has(element)) return;
        state.monitoredFields.set(element, { lastChecked: '', checkTimeout: null });

        element.addEventListener('input', function() {
            if (!shouldAutoCheck() || Date.now() < state.suppressUntil) return;

            const text = getText(this);
            const data = state.monitoredFields.get(this);
            clearTimeout(data.checkTimeout);

            if (text.length === 0 && state.activeIndicator?.element === this) {
                removeIndicator();
                removeInlineHighlights(this);
                updateBadge(0);
                return;
            }

            const sentenceEnd = /[.!?]\s*$/.test(text);
            const isLT = config.apiType === 'languagetool';

            if (sentenceEnd && text.length > 10 && text !== data.lastChecked) {
                data.lastChecked = text;
                checkGrammar(text, this);
            } else if (text.length > 10) {
                const delay = isLT && sentenceEnd ? 300 : getEffectiveInterval();
                data.checkTimeout = setTimeout(() => {
                    if (text !== data.lastChecked) {
                        data.lastChecked = text;
                        checkGrammar(text, element);
                    }
                }, delay);
            }
        });

        element.addEventListener('blur', function() {
            if (!shouldAutoCheck() || Date.now() < state.suppressUntil) return;
            const text = getText(this);
            const data = state.monitoredFields.get(this);
            if (text.length > 10 && text !== data.lastChecked) {
                data.lastChecked = text;
                checkGrammar(text, this);
            }
        });

        element.addEventListener('keydown', function(e) {
            if (e.key !== 'Enter' || e.shiftKey) return;
            const el = this;
            setTimeout(() => {
                if (getText(el).length === 0 && state.activeIndicator?.element === el) {
                    removeIndicator();
                    removeInlineHighlights(el);
                    updateBadge(0);
                    const data = state.monitoredFields.get(el);
                    if (data) data.lastChecked = '';
                }
            }, 300);
        });

        if (element.getAttribute('contenteditable') === 'true' || element.getAttribute('role') === 'textbox') {
            const fieldObserver = new MutationObserver(() => {
                if (getText(element).length === 0 && state.activeIndicator?.element === element) {
                    removeIndicator();
                    removeInlineHighlights(element);
                    updateBadge(0);
                    const data = state.monitoredFields.get(element);
                    if (data) data.lastChecked = '';
                }
            });
            fieldObserver.observe(element, { childList: true, subtree: true, characterData: true });
        }
    }

    function scanForFields() {
        const fields = document.querySelectorAll(
            'textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'
        );
        fields.forEach(attachToField);
    }

    function debouncedScan() {
        clearTimeout(state.scanTimeout);
        state.scanTimeout = setTimeout(scanForFields, 300);
    }

    const observer = new MutationObserver(debouncedScan);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            scanForFields();
            observer.observe(document.body, { childList: true, subtree: true });
        });
    } else {
        scanForFields();
        observer.observe(document.body, { childList: true, subtree: true });
    }

    setTimeout(scanForFields, 1000);
})();
