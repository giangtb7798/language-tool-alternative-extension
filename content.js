// Grammar Checker Content Script v9.0.0
(function() {
    'use strict';

    console.log('[GrammarChecker] v9.0.0 loaded');

    // Shared pure helpers (loaded via manifest before this script).
    const GC = (typeof self !== 'undefined' && self.GrammarCore) ? self.GrammarCore : null;

    // --- Runtime settings (reactive) ---
    const config = {
        autoCheck: true,
        checkInterval: 3000,
        apiType: 'languagetool',
        domainMode: 'blocklist',
        domainList: [],
        customDictionary: [],
        clipboardMonitor: false,
        checkMode: 'auto',      // 'auto' | 'manual' — manual disables typing checks
        goalPreset: ''          // '' | email | casual | academic | creative | business
    };

    function loadConfig() {
        chrome.storage.sync.get(
            ['autoCheck', 'checkInterval', 'apiType', 'domainMode', 'domainList', 'customDictionary', 'clipboardMonitor', 'checkMode', 'goalPreset'],
            (r) => {
                config.autoCheck = r.autoCheck !== false;
                config.checkInterval = (r.checkInterval || 3) * 1000;
                config.apiType = r.apiType || 'languagetool';
                config.domainMode = r.domainMode || 'blocklist';
                config.domainList = r.domainList || [];
                config.customDictionary = r.customDictionary || [];
                config.clipboardMonitor = r.clipboardMonitor === true;
                config.checkMode = r.checkMode || 'auto';
                config.goalPreset = r.goalPreset || '';
            }
        );
    }

    loadConfig();

    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (changes.autoCheck !== undefined) config.autoCheck = changes.autoCheck.newValue !== false;
        if (changes.checkInterval !== undefined) config.checkInterval = (changes.checkInterval.newValue || 3) * 1000;
        if (changes.apiType) config.apiType = changes.apiType.newValue || 'languagetool';
        if (changes.domainMode) config.domainMode = changes.domainMode.newValue || 'blocklist';
        if (changes.domainList) config.domainList = changes.domainList.newValue || [];
        if (changes.customDictionary) config.customDictionary = changes.customDictionary.newValue || [];
        if (changes.clipboardMonitor !== undefined) config.clipboardMonitor = changes.clipboardMonitor.newValue === true;
        if (changes.checkMode) config.checkMode = changes.checkMode.newValue || 'auto';
        if (changes.goalPreset !== undefined) config.goalPreset = changes.goalPreset.newValue || '';
        if (areaName === 'sync' && changes.defaultTargetLanguage) {
            const maybeLang = changes.defaultTargetLanguage.newValue;
            if (isSupportedTranslateLang(maybeLang)) {
                defaultTargetLanguage = maybeLang;
                hasDefaultTargetLanguage = true;
            }
        }
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
        return config.autoCheck && config.checkMode !== 'manual' && isDomainAllowed();
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
            stopSpeaking();
            removeSelectionBtn();
            removeResultPopup();
            if (typeof removeTranslatePopup === 'function') removeTranslatePopup();
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

        /* ---- Selection toolbar (grammar + translate) ---- */
        .gc-selection-toolbar {
            position: fixed;
            display: flex;
            align-items: center;
            gap: 6px;
            z-index: 2147483647;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
            pointer-events: auto;
            filter: drop-shadow(0 3px 8px rgba(0,0,0,0.22));
        }
        .gc-selection-btn {
            background: var(--gc-blue, #3498db);
            color: white;
            padding: 6px 14px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
            transition: background 0.15s, transform 0.15s;
            border: none;
        }
        .gc-selection-btn:hover { background: #2980b9; }
        .gc-selection-btn.gc-loading {
            background: #7f8c8d;
            pointer-events: none;
        }
        .gc-translate-btn {
            background: #16a085;
            color: white;
            padding: 6px 14px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
            transition: background 0.15s, transform 0.15s;
            border: none;
        }
        .gc-translate-btn:hover { background: #1abc9c; }
        .gc-translate-btn.gc-loading {
            background: #7f8c8d;
            pointer-events: none;
        }

        /* ---- Inline language picker ---- */
        .gc-lang-picker {
            background: white;
            border: 2px solid #16a085;
            border-radius: 20px;
            padding: 3px 10px;
            font-size: 12px;
            font-weight: 600;
            color: #16a085;
            cursor: pointer;
            outline: none;
            appearance: none;
            -webkit-appearance: none;
        }
        @media (prefers-color-scheme: dark) {
            .gc-lang-picker { background: #1e2e2e; color: #1abc9c; border-color: #1abc9c; }
        }

        /* ---- Translation result popup ---- */
        .gc-translate-popup {
            position: fixed;
            background: var(--gc-bg, white);
            border: 2px solid #16a085;
            border-radius: 12px;
            padding: 16px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.22);
            z-index: 2147483647;
            max-width: 440px;
            min-width: 280px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
            font-size: 13px;
            line-height: 1.5;
            color: var(--gc-text, #333);
            pointer-events: auto;
        }
        .gc-translate-popup-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .gc-translate-popup-title {
            font-weight: bold;
            color: #16a085;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .gc-translate-lang-tag {
            font-size: 11px;
            font-weight: 600;
            background: rgba(22,160,133,0.12);
            color: #16a085;
            border-radius: 10px;
            padding: 2px 8px;
        }
        .gc-translate-original {
            font-size: 12px;
            color: var(--gc-text-muted, #666);
            background: var(--gc-bg-alt, #f8f9fa);
            border-radius: 6px;
            padding: 8px 10px;
            margin-bottom: 10px;
            border-left: 3px solid #aaa;
            font-style: italic;
            word-break: break-word;
        }
        .gc-translate-context-label {
            font-size: 10px;
            color: #aaa;
            margin-bottom: 2px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .gc-translate-result {
            font-size: 14px;
            font-weight: 600;
            color: var(--gc-text, #222);
            background: rgba(22,160,133,0.07);
            border-radius: 8px;
            padding: 10px 12px;
            margin-bottom: 12px;
            border-left: 3px solid #16a085;
            word-break: break-word;
            white-space: pre-wrap;
        }
        .gc-translate-actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }
        .gc-translate-actions button {
            padding: 5px 14px;
            border: none;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: opacity 0.15s;
        }
        .gc-translate-actions button:hover { opacity: 0.8; }
        .gc-btn-copy { background: #16a085; color: white; }
        .gc-btn-replace { background: var(--gc-green, #27ae60); color: white; }
        .gc-translate-error {
            padding: 10px;
            background: var(--gc-red-light, #fef2f2);
            border-radius: 6px;
            color: var(--gc-red-text, #c0392b);
            margin-bottom: 10px;
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
        .gc-error-item .gc-reason, .gc-error-item .gc-why { color: var(--gc-text-muted, #666); font-size: 12px; margin-top: 6px; }
        .gc-error-item .gc-why summary { cursor: pointer; font-weight: 700; color: var(--gc-blue, #3498db); }
        .gc-error-item .gc-why div { margin-top: 4px; font-style: italic; }
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
        .gc-stream-cursor { color: var(--gc-blue, #3498db); animation: gc-blink 0.7s infinite; }
        @keyframes gc-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
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
        .gc-fixall-row { display: flex; gap: 8px; }
        .gc-fix-review { background: var(--gc-blue, #3498db); }
        .gc-fix-review:hover { background: var(--gc-blue-dark, #2980b9); }

        /* ---- Diff review ---- */
        .gc-diff-row {
            display: flex; align-items: center; gap: 8px;
            padding: 8px 10px; margin-bottom: 6px;
            background: var(--gc-bg-alt, #f8f9fa); border-radius: 6px;
            border-left: 3px solid var(--gc-green, #27ae60);
            font-size: 13px;
        }
        .gc-diff-row.gc-rejected { opacity: 0.45; border-left-color: #aaa; }
        .gc-diff-text { flex: 1; word-break: break-word; }
        .gc-diff-del { color: var(--gc-red, #e74c3c); text-decoration: line-through; }
        .gc-diff-ins { color: var(--gc-green, #27ae60); font-weight: 600; }
        .gc-diff-toggle {
            border: none; border-radius: 4px; cursor: pointer;
            font-size: 12px; font-weight: 700; padding: 3px 9px;
            background: var(--gc-green, #27ae60); color: white;
        }
        .gc-diff-toggle.gc-off { background: #e0e0e0; color: #777; }
        .gc-diff-apply {
            width: 100%; padding: 10px; margin-top: 8px;
            background: var(--gc-green, #27ae60); color: white;
            border: none; border-radius: 6px; cursor: pointer;
            font-weight: bold; font-size: 13px;
        }

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

        /* ---- Textarea/input highlight overlay (mirror technique) ---- */
        .gc-overlay {
            position: absolute;
            z-index: 2147483646;
            pointer-events: none;
            overflow: hidden;
            color: transparent;
            white-space: pre-wrap;
            word-wrap: break-word;
            box-sizing: border-box;
            margin: 0;
            background: transparent;
        }
        .gc-overlay .gc-ov-mark {
            text-decoration: underline wavy #e74c3c;
            text-decoration-skip-ink: none;
            pointer-events: auto;
            cursor: pointer;
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
        .gc-toast-undo { display: flex; align-items: center; gap: 8px; }
        .gc-undo-btn {
            background: rgba(255,255,255,0.25);
            color: white; border: 1px solid rgba(255,255,255,0.6);
            border-radius: 6px; padding: 2px 10px; font-size: 12px;
            font-weight: 700; cursor: pointer;
        }
        .gc-undo-btn:hover { background: rgba(255,255,255,0.4); }
        @keyframes gc-toast-in {
            from { transform: translateY(16px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }

        /* ---- Speak / Read button ---- */
        .gc-speak-btn {
            background: #9b59b6;
            color: white;
            padding: 6px 14px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
            transition: background 0.15s, transform 0.15s;
            border: none;
        }
        .gc-speak-btn:hover { background: #8e44ad; }
        .gc-speak-btn.gc-speaking {
            background: #7d3c98;
            animation: gc-pulse 1s ease-in-out infinite;
        }
        .gc-speak-btn.gc-loading {
            background: #7f8c8d;
            pointer-events: none;
        }
        @keyframes gc-pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
        }

        /* ---- Explain / Word Study button ---- */
        .gc-explain-btn {
            background: #e67e22;
            color: white;
            padding: 6px 14px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
            transition: background 0.15s, transform 0.15s;
            border: none;
        }
        .gc-explain-btn:hover { background: #d35400; }
        .gc-explain-btn.gc-loading {
            background: #7f8c8d;
            pointer-events: none;
        }

        /* ---- Word Explain popup ---- */
        .gc-explain-popup {
            position: fixed;
            background: var(--gc-bg, white);
            border: 2px solid #e67e22;
            border-radius: 12px;
            padding: 16px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.22);
            z-index: 2147483647;
            max-width: 460px;
            min-width: 300px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
            font-size: 13px;
            line-height: 1.6;
            color: var(--gc-text, #333);
            pointer-events: auto;
        }
        .gc-explain-popup-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }
        .gc-explain-popup-title {
            font-weight: bold;
            color: #e67e22;
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 15px;
        }
        .gc-explain-word {
            font-size: 22px;
            font-weight: bold;
            color: #d35400;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .gc-explain-section {
            margin-bottom: 10px;
        }
        .gc-explain-section-title {
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: #e67e22;
            margin-bottom: 4px;
        }
        .gc-explain-section-content {
            color: var(--gc-text, #333);
            white-space: pre-wrap;
            word-break: break-word;
        }
        .gc-explain-example-item {
            margin-bottom: 6px;
            padding-left: 10px;
            border-left: 2px solid #e67e22;
        }
        .gc-explain-example-en {
            font-style: italic;
            color: var(--gc-text, #222);
        }
        .gc-explain-example-vi {
            font-size: 12px;
            color: var(--gc-text-muted, #666);
        }
        .gc-explain-actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            margin-top: 12px;
        }
        .gc-explain-actions button {
            padding: 5px 14px;
            border: none;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: opacity 0.15s;
        }
        .gc-explain-actions button:hover { opacity: 0.8; }
        .gc-btn-speak { background: #9b59b6; color: white; }
        .gc-btn-copy { background: #16a085; color: white; }
        .gc-btn-examples { background: #e67e22; color: white; }
        .gc-explain-error {
            padding: 10px;
            background: var(--gc-red-light, #fef2f2);
            border-radius: 6px;
            color: var(--gc-red-text, #c0392b);
        }
        @media (prefers-color-scheme: dark) {
            .gc-speak-btn { background: #8e44ad; }
            .gc-speak-btn:hover { background: #7d3c98; }
            .gc-speak-btn.gc-speaking { background: #6c3483; }
            .gc-explain-btn { background: #d35400; }
            .gc-explain-btn:hover { background: #e67e22; }
            .gc-explain-popup { border-color: #d35400; }
            .gc-explain-word { color: #e67e22; }
            .gc-explain-section-title { color: #e67e22; }
            .gc-explain-example-item { border-left-color: #e67e22; }
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

    // --- Text-to-Speech (read word or sentence aloud) ---

    const SPEAK_LANG_MAP = {
        'English': 'en-US',
        'Vietnamese': 'vi-VN',
        'Spanish': 'es-ES',
        'French': 'fr-FR',
        'German': 'de-DE',
        'Japanese': 'ja-JP',
        'Korean': 'ko-KR',
        'Chinese': 'zh-CN',
        'Portuguese': 'pt-BR',
        'Russian': 'ru-RU',
        'Indonesian': 'id-ID',
        'Thai': 'th-TH',
        'auto': 'en-US'
    };

    let activeSpeakBtn = null;

    function resetSpeakButton() {
        if (activeSpeakBtn) {
            activeSpeakBtn.classList.remove('gc-speaking');
            activeSpeakBtn.textContent = '🔊 Read';
            activeSpeakBtn = null;
        }
    }

    function stopSpeaking() {
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }
        resetSpeakButton();
    }

    function pickVoice(langCode) {
        const voices = window.speechSynthesis.getVoices();
        if (!voices.length) return null;
        const prefix = langCode.split('-')[0].toLowerCase();
        return voices.find(v => v.lang.toLowerCase().startsWith(prefix))
            || voices.find(v => v.default)
            || voices[0];
    }

    function speakText(text, options = {}) {
        if (!window.speechSynthesis) {
            showToast('Text-to-speech is not supported here', 'warning');
            return;
        }

        const trimmed = (text || '').trim();
        if (!trimmed) return;

        stopSpeaking();

        const langCode = SPEAK_LANG_MAP[options.language] || options.langCode || 'en-US';
        const rate = typeof options.rate === 'number' ? options.rate : 0.95;
        const btn = options.button || null;

        const startSpeaking = () => {
            const utterance = new SpeechSynthesisUtterance(trimmed);
            utterance.lang = langCode;
            utterance.rate = rate;
            const voice = pickVoice(langCode);
            if (voice) utterance.voice = voice;

            if (btn) {
                activeSpeakBtn = btn;
                btn.classList.add('gc-speaking');
                btn.textContent = '⏹ Stop';
            }

            utterance.onend = resetSpeakButton;
            utterance.onerror = resetSpeakButton;

            window.speechSynthesis.speak(utterance);
        };

        if (window.speechSynthesis.getVoices().length === 0) {
            window.speechSynthesis.addEventListener('voiceschanged', startSpeaking, { once: true });
            window.speechSynthesis.getVoices();
        } else {
            startSpeaking();
        }
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

        if (request.action === 'readAloud') {
            chrome.storage.sync.get(['language', 'speakRate'], (r) => {
                speakText(request.text, {
                    language: request.language || r.language,
                    rate: request.rate ?? r.speakRate
                });
            });
            sendResponse({ success: true });
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

    // --- Parse detected language from result (delegated to grammar-core) ---

    function extractDetectedLang(result) {
        if (GC) return GC.extractDetectedLang(result);
        const m = result.match(/\[DETECTED_LANG:([^:]+):([^:]+):([^\]]+)\]/);
        if (!m) return null;
        return { code: m[1], flag: m[2], name: m[3] };
    }

    function stripLangLine(result) {
        if (GC) return GC.stripLangLine(result);
        return result.replace(/\[DETECTED_LANG:[^\]]+\]\n?/g, '');
    }

    // Returns { isClean, matches, reasons, raw } where matches keep the legacy
    // array shape ([_, incorrect, correct]) used throughout this file.
    function parseGrammarResult(result) {
        const parsed = GC
            ? GC.parseGrammarResult(result, config.customDictionary)
            : fallbackParse(result);
        const matches = parsed.errors.map(e => [null, e.incorrect, e.correct]);
        const reasons = parsed.errors.map(e => [null, e.reason]);
        return { isClean: parsed.isClean, matches, reasons, raw: parsed.raw };
    }

    function fallbackParse(result) {
        result = stripLangLine(result || '');
        let pairs = Array.from(result.matchAll(/❌\s*"([^"]+)"\s*→\s*✅\s*"([^"]+)"/g));
        const reasons = Array.from(result.matchAll(/Reason:\s*(.+)/gi));
        const errors = pairs.map((m, i) => ({ incorrect: m[1], correct: m[2], reason: reasons[i]?.[1]?.trim() || '' }));
        const filtered = config.customDictionary.length
            ? errors.filter(e => !config.customDictionary.map(w => w.toLowerCase()).includes(e.incorrect.toLowerCase()))
            : errors;
        const isClean = filtered.length === 0 && !result.includes('❌');
        return { isClean, errors: filtered, raw: result };
    }

    // --- Undo stack for fixes ---
    const undoStack = new WeakMap(); // element -> previous text

    function applyFixes(element, matches) {
        // Remove highlights first so execCommand doesn't inherit the wavy underline style
        removeInlineHighlights(element);

        const before = getText(element);
        const edits = matches.map(m => ({ incorrect: m[1], correct: m[2] }));

        let text;
        if (GC) {
            text = GC.applyFixesToText(before, edits);
        } else {
            text = before;
            edits.forEach(e => {
                const startBound = /^\w/.test(e.incorrect) ? '\\b' : '(?<!\\w)';
                const endBound = /\w$/.test(e.incorrect) ? '\\b' : '(?!\\w)';
                const re = new RegExp(`${startBound}${escapeRegex(e.incorrect)}${endBound}`);
                if (re.test(text)) text = text.replace(re, e.correct);
                else text = text.replace(new RegExp(`${startBound}${escapeRegex(e.incorrect)}${endBound}`, 'i'), e.correct);
            });
            text = text.replace(/([,;:!?.])(\1)+/g, '$1');
        }

        edits.forEach(e => {
            try {
                chrome.runtime.sendMessage({ action: 'logMistake', incorrect: e.incorrect, correct: e.correct });
            } catch (_) {}
        });

        const fieldData = state.monitoredFields.get(element);
        if (fieldData) fieldData.lastChecked = text;
        state.suppressUntil = Date.now() + 2000;

        // Track fixes in session stats
        try {
            chrome.runtime.sendMessage({ action: 'incrementStat', key: 'errorsFixed', amount: matches.length });
        } catch (_) {}

        // Snapshot for undo, then apply.
        undoStack.set(element, before);
        setText(element, text);
        showUndoToast(element, before);
    }

    function showUndoToast(element, previousText) {
        const existing = document.querySelector('.gc-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'gc-toast success gc-toast-undo';
        toast.style.pointerEvents = 'auto';
        toast.innerHTML = '✅ Fixed — <button class="gc-undo-btn">Undo</button>';
        document.body.appendChild(toast);

        const remove = () => toast.remove();
        const timer = setTimeout(remove, 5000);

        toast.querySelector('.gc-undo-btn').addEventListener('click', () => {
            clearTimeout(timer);
            state.suppressUntil = Date.now() + 2000;
            setText(element, previousText);
            const fieldData = state.monitoredFields.get(element);
            if (fieldData) fieldData.lastChecked = previousText;
            undoStack.delete(element);
            remove();
            showToast('↩ Reverted', 'info', 1500);
        });
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
        // Textarea / input: use the overlay-mirror technique.
        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
            applyTextareaHighlights(element, matches);
            return;
        }

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
        removeTextareaHighlights(element);
        const existing = inlineHighlightMap.get(element);
        if (!existing) return;
        existing.forEach(({ span }) => {
            if (!span.parentNode) return;
            const text = document.createTextNode(span.textContent);
            span.parentNode.replaceChild(text, span);
        });
        inlineHighlightMap.delete(element);
    }

    // --- Textarea / input overlay highlights (mirror technique) ---
    // We render a transparent <div> behind the field that mirrors its text,
    // wrapping flagged substrings in underlined <span>s. The overlay tracks the
    // field's geometry, font, padding and scroll position so wavy underlines
    // line up with the real characters.
    const textareaOverlayMap = new WeakMap(); // element -> { overlay, cleanup }

    const OVERLAY_COPY_PROPS = [
        'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
        'textTransform', 'wordSpacing', 'lineHeight', 'textIndent',
        'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
        'boxSizing'
    ];

    function buildOverlaySegments(text, matches) {
        // Compute non-overlapping [start,end) ranges for the first occurrence
        // of each flagged substring.
        const ranges = [];
        const used = [];
        matches.forEach(m => {
            const needle = m[1];
            if (!needle) return;
            let from = 0, idx;
            while ((idx = text.indexOf(needle, from)) !== -1) {
                const end = idx + needle.length;
                const clash = used.some(r => idx < r.end && end > r.start);
                if (!clash) {
                    ranges.push({ start: idx, end, incorrect: needle, correct: m[2] });
                    used.push({ start: idx, end });
                    break;
                }
                from = idx + 1;
            }
        });
        ranges.sort((a, b) => a.start - b.start);
        return ranges;
    }

    function applyTextareaHighlights(element, matches) {
        removeTextareaHighlights(element);
        if (!matches || matches.length === 0) return;

        const text = element.value || '';
        const ranges = buildOverlaySegments(text, matches);
        if (ranges.length === 0) return;

        const overlay = document.createElement('div');
        overlay.className = 'gc-overlay gc-root';

        // Build content with marks.
        let cursor = 0;
        ranges.forEach(r => {
            if (r.start > cursor) overlay.appendChild(document.createTextNode(text.slice(cursor, r.start)));
            const mark = document.createElement('span');
            mark.className = 'gc-ov-mark';
            mark.textContent = text.slice(r.start, r.end);
            mark.dataset.incorrect = r.incorrect;
            mark.dataset.correct = r.correct;
            mark.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                removeInlineBubble();
                showInlineBubble(mark, element, r.incorrect, r.correct);
            });
            overlay.appendChild(mark);
            cursor = r.end;
        });
        if (cursor < text.length) overlay.appendChild(document.createTextNode(text.slice(cursor)));

        document.body.appendChild(overlay);

        const sync = () => syncOverlayGeometry(element, overlay);
        sync();

        element.addEventListener('scroll', sync, { passive: true });
        window.addEventListener('scroll', sync, { passive: true });
        window.addEventListener('resize', sync, { passive: true });

        textareaOverlayMap.set(element, {
            overlay,
            cleanup: () => {
                element.removeEventListener('scroll', sync);
                window.removeEventListener('scroll', sync);
                window.removeEventListener('resize', sync);
            }
        });
    }

    function syncOverlayGeometry(element, overlay) {
        if (!document.body.contains(element)) { removeTextareaHighlights(element); return; }
        const rect = element.getBoundingClientRect();
        const cs = window.getComputedStyle(element);
        overlay.style.left = (rect.left + window.scrollX) + 'px';
        overlay.style.top = (rect.top + window.scrollY) + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
        OVERLAY_COPY_PROPS.forEach(p => { overlay.style[p] = cs[p]; });
        overlay.style.borderStyle = 'solid';
        overlay.style.borderColor = 'transparent';
        // input (single line) doesn't wrap.
        overlay.style.whiteSpace = element.tagName === 'INPUT' ? 'pre' : 'pre-wrap';
        overlay.scrollTop = element.scrollTop;
        overlay.scrollLeft = element.scrollLeft;
    }

    function removeTextareaHighlights(element) {
        const data = textareaOverlayMap.get(element);
        if (!data) return;
        data.cleanup();
        if (data.overlay.parentNode) data.overlay.remove();
        textareaOverlayMap.delete(element);
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

    // --- Selection toolbar (Grammar + Translate) ---

    let selectionBtn = null;   // now a toolbar div
    let selectionDebounce = null;
    let activeTranslatePopup = null;

    // Languages for the picker
    const TRANSLATE_LANGS = [
        { code: 'Vietnamese',  flag: '🇻🇳', label: 'Vietnamese' },
        { code: 'English',     flag: '🇬🇧', label: 'English' },
        { code: 'Spanish',     flag: '🇪🇸', label: 'Spanish' },
        { code: 'French',      flag: '🇫🇷', label: 'French' },
        { code: 'German',      flag: '🇩🇪', label: 'German' },
        { code: 'Japanese',    flag: '🇯🇵', label: 'Japanese' },
        { code: 'Korean',      flag: '🇰🇷', label: 'Korean' },
        { code: 'Chinese',     flag: '🇨🇳', label: 'Chinese' },
        { code: 'Portuguese',  flag: '🇵🇹', label: 'Portuguese' },
        { code: 'Russian',     flag: '🇷🇺', label: 'Russian' },
        { code: 'Indonesian',  flag: '🇮🇩', label: 'Indonesian' },
        { code: 'Thai',        flag: '🇹🇭', label: 'Thai' },
    ];

    let defaultTargetLanguage = 'Vietnamese';
    let hasDefaultTargetLanguage = false;

    function isSupportedTranslateLang(lang) {
        return TRANSLATE_LANGS.some(l => l.code === lang);
    }

    function resolveTranslateLang(lang) {
        if (isSupportedTranslateLang(lang)) return lang;
        return 'Vietnamese';
    }

    function getTranslateButtonText() {
        const info = TRANSLATE_LANGS.find(l => l.code === defaultTargetLanguage);
        return `🌐 Translate -> ${(info && info.label) || defaultTargetLanguage}`;
    }

    chrome.storage.sync.get(['defaultTargetLanguage'], (syncRes) => {
        if (isSupportedTranslateLang(syncRes.defaultTargetLanguage)) {
            defaultTargetLanguage = syncRes.defaultTargetLanguage;
            hasDefaultTargetLanguage = true;
            return;
        }
        chrome.storage.local.get(['lastTranslateLang'], (localRes) => {
            defaultTargetLanguage = resolveTranslateLang(localRes.lastTranslateLang);
            hasDefaultTargetLanguage = false;
        });
    });

    function removeSelectionBtn() {
        if (selectionBtn) { selectionBtn.remove(); selectionBtn = null; }
        if (activeSpeakBtn) stopSpeaking();
    }

    function removeTranslatePopup() {
        if (activeTranslatePopup) { activeTranslatePopup.remove(); activeTranslatePopup = null; }
    }

    /**
     * Extract surrounding context for the current selection.
     * Walks up the DOM to find the nearest meaningful block of text,
     * returns up to 400 chars around the selection so the LLM can
     * resolve ambiguous/polysemous words correctly.
     */
    function getSelectionContext(selection) {
        try {
            const anchor = selection.anchorNode;
            if (!anchor) return { context: '', pageTitle: document.title };

            // Walk up to find a block-level container
            let el = anchor.nodeType === 3 ? anchor.parentElement : anchor;
            const blockTags = new Set(['P','DIV','ARTICLE','SECTION','LI','TD','BLOCKQUOTE','FIGURE','HEADER','FOOTER','MAIN','NAV']);
            let block = el;
            while (block && block !== document.body) {
                if (blockTags.has(block.tagName)) break;
                block = block.parentElement;
            }
            if (!block || block === document.body) block = el;

            // Get the full text of that block
            const blockText = (block.innerText || block.textContent || '').replace(/\s+/g, ' ').trim();

            // Find position of selected text in the block
            const selectedText = selection.toString().trim();
            const idx = blockText.indexOf(selectedText);

            let context = '';
            if (idx !== -1 && blockText.length > selectedText.length + 10) {
                // Take up to 200 chars before and 200 chars after
                const before = blockText.slice(Math.max(0, idx - 200), idx);
                const after = blockText.slice(idx + selectedText.length, idx + selectedText.length + 200);
                // Build context with the selected word highlighted via markers
                context = (before + `[${selectedText}]` + after).trim();
            } else {
                context = blockText.slice(0, 400);
            }

            return { context: context.slice(0, 450), pageTitle: document.title };
        } catch (_) {
            return { context: '', pageTitle: document.title };
        }
    }

    /**
     * Show translation result popup.
     * Parses the LLM response to extract the --- Translation --- section.
     */
    function showTranslationResult(originalText, result, error, anchorRect, editableEl, targetLang) {
        removeTranslatePopup();

        const langInfo = TRANSLATE_LANGS.find(l => l.code === targetLang) || { flag: '🌐', label: targetLang };

        const popup = document.createElement('div');
        popup.className = 'gc-translate-popup gc-root';

        if (error) {
            popup.innerHTML = `
                <div class="gc-translate-popup-header">
                    <span class="gc-translate-popup-title">🌐 Translation Error</span>
                    <button class="gc-popup-close" style="cursor:pointer;font-size:18px;color:#999;padding:0 4px;background:none;border:none;">&times;</button>
                </div>
                <div class="gc-translate-error">${escapeHTML(error)}</div>
            `;
        } else {
            // Parse the --- Translation --- section
            let translatedText = result || '';
            const translationMatch = result && result.match(/---\s*Translation\s*---\s*([\s\S]*?)(?:---\s*Grammar Check\s*---|$)/i);
            if (translationMatch) {
                translatedText = translationMatch[1].trim();
            }

            const truncatedOriginal = originalText.length > 120
                ? originalText.slice(0, 120) + '…'
                : originalText;

            popup.innerHTML = `
                <div class="gc-translate-popup-header">
                    <span class="gc-translate-popup-title">
                        🌐 Translation
                        <span class="gc-translate-lang-tag">${langInfo.flag} ${langInfo.label}</span>
                    </span>
                    <button class="gc-popup-close" style="cursor:pointer;font-size:18px;color:#999;padding:0 4px;background:none;border:none;">&times;</button>
                </div>
                <div class="gc-translate-original">"${escapeHTML(truncatedOriginal)}"</div>
                <div class="gc-translate-context-label">Translation</div>
                <div class="gc-translate-result">${escapeHTML(translatedText)}</div>
                <div class="gc-translate-actions">
                    <button class="gc-btn-copy">📋 Copy</button>
                    ${editableEl ? '<button class="gc-btn-replace">✏️ Replace</button>' : ''}
                </div>
            `;

            // Copy button
            popup.querySelector('.gc-btn-copy').addEventListener('click', () => {
                navigator.clipboard.writeText(translatedText).then(() => {
                    const btn = popup.querySelector('.gc-btn-copy');
                    btn.textContent = '✓ Copied!';
                    setTimeout(() => { btn.textContent = '📋 Copy'; }, 1500);
                }).catch(() => {
                    // Fallback
                    const ta = document.createElement('textarea');
                    ta.value = translatedText;
                    ta.style.position = 'fixed'; ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    ta.remove();
                    const btn = popup.querySelector('.gc-btn-copy');
                    btn.textContent = '✓ Copied!';
                    setTimeout(() => { btn.textContent = '📋 Copy'; }, 1500);
                });
            });

            // Replace button
            const replaceBtn = popup.querySelector('.gc-btn-replace');
            if (replaceBtn && editableEl) {
                replaceBtn.addEventListener('click', () => {
                    setText(editableEl, translatedText);
                    removeTranslatePopup();
                    showToast('✅ Text replaced with translation', 'success');
                });
            }
        }

        popup.querySelector('.gc-popup-close').addEventListener('click', removeTranslatePopup);

        document.body.appendChild(popup);
        activeTranslatePopup = popup;

        // Position popup below selection
        requestAnimationFrame(() => {
            const pRect = popup.getBoundingClientRect();
            let left, top;
            if (anchorRect && anchorRect.width > 0) {
                left = anchorRect.left + (anchorRect.width / 2) - (pRect.width / 2);
                top = anchorRect.bottom + 44; // below toolbar
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
                removeTranslatePopup();
                document.removeEventListener('mousedown', dismissOnClick);
            }
        });
    }

    /**
     * Trigger a translation request with surrounding page context.
     */
    async function triggerTranslation(selectedText, targetLang, editableEl, anchorRect, selectionSnapshot) {
        // Keep local fallback in sync with the latest selected language
        defaultTargetLanguage = resolveTranslateLang(targetLang);
        chrome.storage.local.set({ lastTranslateLang: defaultTargetLanguage });

        // Extract context from selection
        const { context, pageTitle } = getSelectionContext(selectionSnapshot);

        try {
            const settings = await chrome.storage.sync.get(
                ['apiType', 'hybridLlmType', 'openaiApiKey', 'openaiModel', 'localUrl', 'localModel', 'localApiKey', 'language', 'goalPreset', 'rateLimitPerMin']
            );

            const response = await chrome.runtime.sendMessage({
                action: 'translateText',
                text: selectedText,
                settings,
                sourceLang: 'auto',
                targetLang,
                context,
                pageTitle
            });

            removeSelectionBtn();

            if (response && response.success) {
                showTranslationResult(selectedText, response.result, null, anchorRect, editableEl, targetLang);
            } else {
                showTranslationResult(selectedText, null, response?.error || 'Translation failed', anchorRect, null, targetLang);
            }
        } catch (err) {
            removeSelectionBtn();
            showTranslationResult(selectedText, null, err.message || 'Translation failed', anchorRect, null, targetLang);
        }
    }

    function onSelectionChange() {
        clearTimeout(selectionDebounce);
        selectionDebounce = setTimeout(() => {
            const selection = window.getSelection();
            const text = selection.toString().trim();

            if (text.length < 1 || !selection.rangeCount) {
                removeSelectionBtn();
                return;
            }

            const anchor = selection.anchorNode;
            const anchorEl = anchor && (anchor.nodeType === 3 ? anchor.parentElement : anchor);
            if (anchorEl && (
                anchorEl.closest('.gc-selection-toolbar') ||
                anchorEl.closest('.gc-result-popup') ||
                anchorEl.closest('.gc-translate-popup') ||
                anchorEl.closest('.gc-explain-popup')
            )) return;

            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return;

            removeSelectionBtn();

            // Snapshot selection state before async ops
            const selectedText = text;
            const anchorRect = { ...rect, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
            const editableEl = findEditableAncestor(selection.anchorNode);
            const selectionSnapshot = selection; // for context extraction (sync)

            // --- Build toolbar ---
            const toolbar = document.createElement('div');
            toolbar.className = 'gc-selection-toolbar gc-root';

            // Read aloud button
            const speakBtn = document.createElement('button');
            speakBtn.className = 'gc-speak-btn';
            speakBtn.textContent = '🔊 Read';
            speakBtn.title = 'Read selection aloud';

            // Grammar button
            const grammarBtn = document.createElement('button');
            grammarBtn.className = 'gc-selection-btn';
            grammarBtn.textContent = '✓ Grammar';

            // Translate button
            const translateBtn = document.createElement('button');
            translateBtn.className = 'gc-translate-btn';
            translateBtn.textContent = getTranslateButtonText();

            // Goal preset picker (manual context override for grammar checks)
            const goalPicker = document.createElement('select');
            goalPicker.className = 'gc-lang-picker';
            goalPicker.title = 'Writing goal';
            [
                ['', 'Auto'], ['email', 'Email'], ['casual', 'Casual'],
                ['business', 'Business'], ['academic', 'Academic'], ['creative', 'Creative']
            ].forEach(([value, label]) => {
                const opt = document.createElement('option');
                opt.value = value;
                opt.textContent = label;
                if (value === config.goalPreset) opt.selected = true;
                goalPicker.appendChild(opt);
            });

            // Language picker (hidden, shown on translate click)
            const langPicker = document.createElement('select');
            langPicker.className = 'gc-lang-picker';
            langPicker.style.display = 'none';
            TRANSLATE_LANGS.forEach(l => {
                const opt = document.createElement('option');
                opt.value = l.code;
                opt.textContent = `${l.flag} ${l.label}`;
                if (l.code === defaultTargetLanguage) opt.selected = true;
                langPicker.appendChild(opt);
            });

            toolbar.appendChild(speakBtn);
            toolbar.appendChild(grammarBtn);
            toolbar.appendChild(goalPicker);
            toolbar.appendChild(translateBtn);
            toolbar.appendChild(langPicker);

            speakBtn.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (speakBtn.classList.contains('gc-speaking')) {
                    stopSpeaking();
                    return;
                }
                chrome.storage.sync.get(['language', 'speakRate'], (r) => {
                    speakText(selectedText, {
                        language: r.language,
                        rate: r.speakRate,
                        button: speakBtn
                    });
                });
            });

            // Position toolbar above selection
            let left = rect.left + (rect.width / 2);
            let top = rect.top - 38;
            if (top < 8) top = rect.bottom + 8;
            toolbar.style.left = left + 'px';
            toolbar.style.top = top + 'px';
            toolbar.style.transform = 'translateX(-50%)';

            goalPicker.addEventListener('change', () => {
                config.goalPreset = goalPicker.value;
                chrome.storage.sync.set({ goalPreset: config.goalPreset });
            });

            // Grammar button handler
            grammarBtn.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                grammarBtn.textContent = '⏳ Checking...';
                grammarBtn.classList.add('gc-loading');

                chrome.storage.sync.get(
                    ['apiType', 'hybridLlmType', 'openaiApiKey', 'openaiModel', 'localUrl', 'localModel', 'localApiKey', 'language', 'goalPreset', 'rateLimitPerMin'],
                    (settings) => {
                        settings.goalPreset = goalPicker.value;
                        const apiType = settings.apiType || 'languagetool';
                        if (apiType === 'openai' || apiType === 'local') {
                            removeSelectionBtn();
                            streamGrammarPopup(selectedText, settings, window.location.href, anchorRect, editableEl)
                                .catch(() => chrome.runtime.sendMessage(
                                    { action: 'grammarCheck', text: selectedText, settings, domain: window.location.href },
                                    (response) => {
                                        if (response && response.success) showContextMenuResult(selectedText, response.result, null, editableEl);
                                        else showContextMenuResult(selectedText, null, response?.error || 'Unknown error', null);
                                    }
                                ));
                            return;
                        }
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

            // Translate button: one-click translate when default exists.
            translateBtn.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (hasDefaultTargetLanguage) {
                    translateBtn.textContent = '⏳ Translating...';
                    translateBtn.classList.add('gc-loading');
                    grammarBtn.style.display = 'none';
                    triggerTranslation(selectedText, defaultTargetLanguage, editableEl, anchorRect, selectionSnapshot);
                    return;
                }

                if (langPicker.style.display === 'none') {
                    langPicker.style.display = '';
                    translateBtn.textContent = '🌐 Set language';
                    setTimeout(() => langPicker.focus(), 50);
                }
            });

            // First-time setup: changing language saves default and translates immediately.
            langPicker.addEventListener('change', () => {
                const targetLang = resolveTranslateLang(langPicker.value);
                defaultTargetLanguage = targetLang;
                hasDefaultTargetLanguage = true;
                chrome.storage.sync.set({ defaultTargetLanguage: targetLang });
                chrome.storage.local.set({ lastTranslateLang: targetLang });
                translateBtn.textContent = '⏳ Translating...';
                translateBtn.classList.add('gc-loading');
                grammarBtn.style.display = 'none';
                langPicker.style.display = 'none';
                triggerTranslation(selectedText, targetLang, editableEl, anchorRect, selectionSnapshot);
            });

            langPicker.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    langPicker.dispatchEvent(new Event('change'));
                }
            });

            document.body.appendChild(toolbar);
            selectionBtn = toolbar;

            // Clamp to viewport
            requestAnimationFrame(() => {
                const tRect = toolbar.getBoundingClientRect();
                let adjustedLeft = left;
                if (tRect.right > window.innerWidth - 8) adjustedLeft = left - (tRect.right - window.innerWidth + 8);
                if (tRect.left < 8) adjustedLeft = left + (8 - tRect.left);
                toolbar.style.left = adjustedLeft + 'px';
            });
        }, 300);
    }

    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mousedown', (e) => {
        if (selectionBtn && !selectionBtn.contains(e.target)) removeSelectionBtn();
    });

    // --- Synonym / word-tune on double-click ---
    // Double-clicking a single word inside an editable field offers inline
    // synonym suggestions (lighter-weight than the full Explain popup).
    let activeSynonymPopup = null;

    function removeSynonymPopup() {
        if (activeSynonymPopup) { activeSynonymPopup.remove(); activeSynonymPopup = null; }
    }

    document.addEventListener('dblclick', (e) => {
        const editableEl = findEditableAncestor(e.target);
        if (!editableEl) return;
        const sel = window.getSelection();
        const word = sel.toString().trim();
        // Single word only (no spaces), reasonable length.
        if (!word || /\s/.test(word) || word.length < 2 || word.length > 40) return;
        if (!sel.rangeCount) return;
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        showSynonymPopup(word, rect, editableEl);
    });

    function showSynonymPopup(word, rect, editableEl) {
        removeSynonymPopup();

        const popup = document.createElement('div');
        popup.className = 'gc-inline-bubble gc-root';
        popup.style.minWidth = '180px';
        popup.innerHTML = `<div style="font-weight:600;color:var(--gc-blue,#3498db);">Synonyms for "${escapeHTML(word)}"</div><div class="gc-syn-body" style="color:var(--gc-text-muted,#666);font-size:12px;">Loading…</div>`;
        popup.style.left = rect.left + 'px';
        popup.style.top = (rect.bottom + 6) + 'px';
        document.body.appendChild(popup);
        activeSynonymPopup = popup;

        const dismiss = (e) => {
            if (!popup.contains(e.target)) {
                removeSynonymPopup();
                document.removeEventListener('mousedown', dismiss);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', dismiss), 0);

        const ctx = getText(editableEl).slice(0, 200);
        chrome.storage.sync.get(
            ['apiType', 'hybridLlmType', 'openaiApiKey', 'openaiModel', 'localUrl', 'localModel', 'localApiKey', 'language', 'goalPreset', 'rateLimitPerMin'],
            (settings) => {
                if (settings.apiType === 'languagetool') {
                    const body = popup.querySelector('.gc-syn-body');
                    if (body) body.textContent = 'Synonyms need an LLM provider (Hybrid/OpenAI).';
                    return;
                }
                chrome.runtime.sendMessage(
                    { action: 'getSynonyms', word, context: ctx, settings },
                    (response) => {
                        const body = popup.querySelector('.gc-syn-body');
                        if (!body) return;
                        if (!response || !response.success) {
                            body.textContent = (response && response.error) || 'Could not fetch synonyms.';
                            return;
                        }
                        const words = response.result.replace(/\n/g, ',').split(',')
                            .map(w => w.trim().replace(/^["']|["']$/g, '')).filter(Boolean).slice(0, 6);
                        if (words.length === 0) { body.textContent = 'No suggestions.'; return; }
                        body.innerHTML = '';
                        const wrap = document.createElement('div');
                        wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
                        words.forEach(w => {
                            const chip = document.createElement('button');
                            chip.className = 'gc-bubble-fix';
                            chip.style.cssText = 'padding:3px 10px;border:none;border-radius:12px;font-size:12px;cursor:pointer;';
                            chip.textContent = w;
                            chip.addEventListener('mousedown', (ev) => {
                                ev.preventDefault();
                                applyFixes(editableEl, [[null, word, w]]);
                                removeSynonymPopup();
                            });
                            wrap.appendChild(chip);
                        });
                        body.appendChild(wrap);
                    }
                );
            }
        );
    }


    let activeResultPopup = null;

    function removeResultPopup() {
        if (activeResultPopup) { activeResultPopup.remove(); activeResultPopup = null; }
    }

    function streamGrammarPopup(text, settings, domain, anchorRect, editableEl) {
        return new Promise((resolve, reject) => {
            removeResultPopup();
            const popup = document.createElement('div');
            popup.className = 'gc-result-popup gc-root';
            popup.innerHTML = `
                <div class="gc-popup-header">
                    <span class="gc-popup-title">Grammar Check</span>
                    <button class="gc-popup-close">&times;</button>
                </div>
                <div class="gc-raw-result"><span class="gc-stream-text"></span><span class="gc-stream-cursor">|</span></div>
            `;
            popup.querySelector('.gc-popup-close').addEventListener('click', () => {
                removeResultPopup();
                reject(new Error('Cancelled'));
            });
            document.body.appendChild(popup);
            activeResultPopup = popup;
            positionPopupNearRect(popup, anchorRect);

            let fullText = '';
            let port;
            try { port = chrome.runtime.connect({ name: 'stream' }); }
            catch (e) { reject(e); return; }
            port.postMessage({ action: 'streamGrammarCheck', text, settings, domain });
            port.onMessage.addListener((msg) => {
                if (!activeResultPopup || activeResultPopup !== popup) return;
                if (msg.type === 'chunk') {
                    fullText += msg.data || '';
                    const target = popup.querySelector('.gc-stream-text');
                    if (target) target.textContent = fullText;
                } else if (msg.type === 'done') {
                    port.disconnect();
                    removeResultPopup();
                    showContextMenuResult(text, fullText || msg.data || '', null, editableEl);
                    resolve(fullText || msg.data || '');
                } else if (msg.type === 'error') {
                    port.disconnect();
                    reject(new Error(msg.data));
                }
            });
            port.onDisconnect.addListener(() => { if (fullText) resolve(fullText); });
        });
    }

    function positionPopupNearRect(popup, anchorRect) {
        requestAnimationFrame(() => {
            const pRect = popup.getBoundingClientRect();
            let left = anchorRect && anchorRect.width > 0
                ? anchorRect.left + (anchorRect.width / 2) - (pRect.width / 2)
                : (window.innerWidth - pRect.width) / 2;
            let top = anchorRect && anchorRect.width > 0 ? anchorRect.bottom + 8 : (window.innerHeight - pRect.height) / 2;
            if (left + pRect.width > window.innerWidth - 10) left = window.innerWidth - pRect.width - 10;
            if (left < 10) left = 10;
            if (top + pRect.height > window.innerHeight - 10) top = anchorRect ? anchorRect.top - pRect.height - 8 : 10;
            if (top < 10) top = 10;
            popup.style.left = left + 'px';
            popup.style.top = top + 'px';
        });
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

    // --- Diff review popup (accept/reject each change before applying) ---

    function showDiffReview(editableEl, matches, reasons) {
        removeResultPopup();

        const popup = document.createElement('div');
        popup.className = 'gc-result-popup gc-root';

        let rows = '';
        matches.forEach((m, i) => {
            const reason = reasons[i] ? reasons[i][1] : '';
            rows += `<div class="gc-diff-row" data-idx="${i}">
                <div class="gc-diff-text">
                    <span class="gc-diff-del">${escapeHTML(m[1])}</span>
                    <span style="opacity:.6;">→</span>
                    <span class="gc-diff-ins">${escapeHTML(m[2])}</span>
                    ${reason ? `<div class="gc-reason">${escapeHTML(reason)}</div>` : ''}
                </div>
                <button class="gc-diff-toggle" data-idx="${i}" title="Toggle">✓</button>
            </div>`;
        });

        popup.innerHTML = `
            <div class="gc-popup-header">
                <span class="gc-popup-title">Review Changes (${matches.length})</span>
                <button class="gc-popup-close">&times;</button>
            </div>
            ${rows}
            <button class="gc-diff-apply">Apply selected</button>
        `;

        const accepted = new Set(matches.map((_, i) => i));

        popup.querySelectorAll('.gc-diff-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.idx);
                const row = popup.querySelector(`.gc-diff-row[data-idx="${idx}"]`);
                if (accepted.has(idx)) {
                    accepted.delete(idx);
                    btn.classList.add('gc-off');
                    btn.textContent = '✕';
                    if (row) row.classList.add('gc-rejected');
                } else {
                    accepted.add(idx);
                    btn.classList.remove('gc-off');
                    btn.textContent = '✓';
                    if (row) row.classList.remove('gc-rejected');
                }
            });
        });

        popup.querySelector('.gc-diff-apply').addEventListener('click', () => {
            const selected = matches.filter((_, i) => accepted.has(i));
            if (selected.length > 0) applyFixes(editableEl, selected);
            removeResultPopup();
        });

        popup.querySelector('.gc-popup-close').addEventListener('click', removeResultPopup);

        document.body.appendChild(popup);
        activeResultPopup = popup;

        const sel = window.getSelection();
        let anchorRect = sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : null;
        requestAnimationFrame(() => {
            const pRect = popup.getBoundingClientRect();
            let left = anchorRect && anchorRect.width > 0
                ? anchorRect.left + (anchorRect.width / 2) - (pRect.width / 2)
                : (window.innerWidth - pRect.width) / 2;
            let top = anchorRect && anchorRect.width > 0 ? anchorRect.bottom + 8 : (window.innerHeight - pRect.height) / 2;
            if (left + pRect.width > window.innerWidth - 10) left = window.innerWidth - pRect.width - 10;
            if (left < 10) left = 10;
            if (top + pRect.height > window.innerHeight - 10) top = 10;
            if (top < 10) top = 10;
            popup.style.left = left + 'px';
            popup.style.top = top + 'px';
        });

        document.addEventListener('mousedown', function dismiss(e) {
            if (!popup.contains(e.target)) {
                removeResultPopup();
                document.removeEventListener('mousedown', dismiss);
            }
        });
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
                        ${reason ? `<details class="gc-why" open><summary>Why this fix?</summary><div>${escapeHTML(reason)}</div></details>` : ''}
                        <div class="gc-error-actions">
                            ${editableEl ? `<button class="gc-btn-fix-one" data-incorrect="${escapeHTML(incorrect)}" data-correct="${escapeHTML(correct)}">Fix</button>` : ''}
                            <button class="gc-btn-ignore" data-idx="${i}">Ignore</button>
                            <button class="gc-btn-dict" data-word="${escapeHTML(incorrect)}">Add to Dict</button>
                        </div>
                    </div>`;
                });

                if (editableEl) {
                    bodyHTML += '<div class="gc-fixall-row"><button class="gc-fix-btn gc-fix-review">Review &amp; Fix</button><button class="gc-fix-btn">Fix All</button></div>';
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
            const fixAllBtn = popup.querySelector('.gc-fix-btn:not(.gc-fix-review)');
            if (fixAllBtn && editableEl) {
                fixAllBtn.addEventListener('click', () => {
                    applyFixes(editableEl, parsed.matches);
                    fixAllBtn.textContent = '✓ Fixed!';
                    fixAllBtn.classList.add('gc-fixed');
                    setTimeout(removeResultPopup, 800);
                });
            }

            // Review & Fix (diff / accept-per-change)
            const reviewBtn = popup.querySelector('.gc-fix-review');
            if (reviewBtn && editableEl) {
                reviewBtn.addEventListener('click', () => {
                    removeResultPopup();
                    showDiffReview(editableEl, parsed.matches, parsed.reasons);
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
        const data = state.monitoredFields.get(element) || {};
        data.checkSeq = (data.checkSeq || 0) + 1;
        const seq = data.checkSeq;
        state.monitoredFields.set(element, data);
        showLoadingIndicator(element);
        try {
            const settings = await chrome.storage.sync.get([
                'apiType', 'hybridLlmType', 'openaiApiKey', 'openaiModel',
                'localUrl', 'localModel', 'localApiKey', 'language', 'goalPreset', 'rateLimitPerMin'
            ]);

            const response = await chrome.runtime.sendMessage({
                action: 'grammarCheck',
                text,
                settings,
                domain: window.location.href
            });

            const current = state.monitoredFields.get(element);
            if (current && current.checkSeq !== seq) return; // stale response from older request
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
            const current = state.monitoredFields.get(element);
            if (!current || current.checkSeq === seq) removeLoadingIndicator();
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
                    'localUrl', 'localModel', 'localApiKey', 'language', 'goalPreset', 'rateLimitPerMin'
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

    if (window.speechSynthesis) window.speechSynthesis.getVoices();
})();
