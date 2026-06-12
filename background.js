// Background service worker v9.0.0

importScripts('lib/grammar-core.js');
const GC = self.GrammarCore;

const SETTINGS_KEYS = [
    'apiType', 'hybridLlmType', 'openaiApiKey', 'openaiModel',
    'localUrl', 'localModel', 'localApiKey', 'language',
    'goalPreset', 'checkMode', 'rateLimitPerMin'
];

const MAX_HISTORY = 200;

const LANG_CODE_MAP = {
    'English': 'en-US',
    'Vietnamese': 'vi',
    'Spanish': 'es',
    'French': 'fr',
    'German': 'de',
    'Japanese': 'ja',
    'Korean': 'ko',
    'Chinese': 'zh',
    'Portuguese': 'pt-BR',
    'Russian': 'ru',
    'Indonesian': 'id',
    'Thai': 'th',
    'auto': 'auto'
};

// Language display names + flag emojis
const LANG_DISPLAY = {
    'en': { name: 'English', flag: '🇬🇧' },
    'en-US': { name: 'English (US)', flag: '🇺🇸' },
    'en-GB': { name: 'English (UK)', flag: '🇬🇧' },
    'en-AU': { name: 'English (AU)', flag: '🇦🇺' },
    'vi': { name: 'Vietnamese', flag: '🇻🇳' },
    'es': { name: 'Spanish', flag: '🇪🇸' },
    'fr': { name: 'French', flag: '🇫🇷' },
    'de': { name: 'German', flag: '🇩🇪' },
    'ja': { name: 'Japanese', flag: '🇯🇵' },
    'ko': { name: 'Korean', flag: '🇰🇷' },
    'zh': { name: 'Chinese', flag: '🇨🇳' },
    'pt': { name: 'Portuguese', flag: '🇵🇹' },
    'pt-BR': { name: 'Portuguese (BR)', flag: '🇧🇷' },
    'ru': { name: 'Russian', flag: '🇷🇺' },
    'id': { name: 'Indonesian', flag: '🇮🇩' },
    'th': { name: 'Thai', flag: '🇹🇭' },
};

// --- Result cache (avoids re-checking identical text) ---
// Backed by chrome.storage.session so it survives service-worker restarts
// (MV3 tears the worker down after ~30s idle). Kept mirrored in memory for speed.
const grammarCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX_SIZE = 200;
let cacheHydrated = false;

function hashText(text) {
    let h1 = 0, h2 = 0x5a827999;
    for (let i = 0; i < text.length; i++) {
        h1 = ((h1 << 5) - h1) + text.charCodeAt(i); h1 |= 0;
        h2 = ((h2 << 5) + h2) ^ text.charCodeAt(text.length - 1 - i); h2 |= 0;
    }
    return h1.toString(36) + '_' + h2.toString(36) + '_' + text.length;
}

async function hydrateCache() {
    if (cacheHydrated) return;
    cacheHydrated = true;
    try {
        const { grammarCache: stored } = await chrome.storage.session.get('grammarCache');
        if (stored && typeof stored === 'object') {
            for (const [k, v] of Object.entries(stored)) grammarCache.set(k, v);
        }
    } catch (_) {}
}

function persistCache() {
    try {
        chrome.storage.session.set({ grammarCache: Object.fromEntries(grammarCache) });
    } catch (_) {}
}

function getCached(text, apiType) {
    const key = apiType + ':' + hashText(text);
    const entry = grammarCache.get(key);
    if (entry && Date.now() - entry.time < CACHE_TTL) return entry.result;
    if (entry) grammarCache.delete(key);
    return null;
}

function setCache(text, apiType, result) {
    if (grammarCache.size >= CACHE_MAX_SIZE) {
        let oldestKey = null, oldestTime = Infinity;
        for (const [k, v] of grammarCache) {
            if (v.time < oldestTime) { oldestTime = v.time; oldestKey = k; }
        }
        if (oldestKey) grammarCache.delete(oldestKey);
    }
    grammarCache.set(apiType + ':' + hashText(text), { result, time: Date.now() });
    persistCache();
}

const DOMAIN_CONTEXTS = {
    'mail.google.com': 'professional email',
    'outlook.live.com': 'professional email',
    'outlook.office.com': 'professional email',
    'outlook.office365.com': 'professional email',
    'twitter.com': 'social media (concise, within character limits)',
    'x.com': 'social media (concise, within character limits)',
    'linkedin.com': 'professional networking',
    'facebook.com': 'social media',
    'slack.com': 'casual team communication',
    'discord.com': 'casual communication',
    'docs.google.com': 'document writing',
    'notion.so': 'document or note writing',
    'reddit.com': 'online forum discussion',
};

// --- Session statistics (persisted to storage.session so they survive SW restarts) ---
let sessionStats = {
    checksRun: 0,
    errorsFound: 0,
    errorsFixed: 0,
    startTime: Date.now()
};
let statsHydrated = false;

async function hydrateStats() {
    if (statsHydrated) return;
    statsHydrated = true;
    try {
        const { sessionStats: stored } = await chrome.storage.session.get('sessionStats');
        if (stored && typeof stored === 'object') sessionStats = { ...sessionStats, ...stored };
    } catch (_) {}
}

function persistStats() {
    try { chrome.storage.session.set({ sessionStats }); } catch (_) {}
}

// --- Rate limiter (cost guard) ---
// Sliding 60s window of LLM call timestamps. Default 20/min, configurable.
let llmCallTimestamps = [];
function checkRateLimit(limitPerMin) {
    const limit = limitPerMin || 20;
    const now = Date.now();
    llmCallTimestamps = llmCallTimestamps.filter(t => now - t < 60000);
    if (llmCallTimestamps.length >= limit) {
        const oldest = llmCallTimestamps[0];
        const waitS = Math.ceil((60000 - (now - oldest)) / 1000);
        throw new Error(`Rate limit reached (${limit}/min). Try again in ${waitS}s or raise the limit in Settings.`);
    }
    llmCallTimestamps.push(now);
}

// --- Setup ---

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'checkGrammar',
        title: 'Check Grammar',
        contexts: ['selection']
    });
    chrome.contextMenus.create({
        id: 'readAloud',
        title: 'Read aloud',
        contexts: ['selection']
    });
});

// --- Keyboard shortcuts ---

chrome.commands.onCommand.addListener(async (command) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    if (command === 'check-grammar') {
        try {
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'getSelectedText' });
            if (!response?.text) return;
            const settings = await chrome.storage.sync.get(SETTINGS_KEYS);
            const result = await handleGrammarCheck(response.text, settings, tab.url);
            chrome.tabs.sendMessage(tab.id, { action: 'showGrammarResult', text: response.text, result });
        } catch (_) {}
    }

    if (command === 'fix-all') {
        try {
            chrome.tabs.sendMessage(tab.id, { action: 'fixAll' });
        } catch (_) {}
    }
});

// --- Context menu ---

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!info.selectionText || !tab?.id) return;

    if (info.menuItemId === 'readAloud') {
        try {
            await chrome.tabs.sendMessage(tab.id, {
                action: 'readAloud',
                text: info.selectionText
            });
        } catch (_) {}
        return;
    }

    if (info.menuItemId !== 'checkGrammar') return;

    try {
        const settings = await chrome.storage.sync.get(SETTINGS_KEYS);
        const result = await handleGrammarCheck(info.selectionText, settings, tab.url);
        chrome.tabs.sendMessage(tab.id, {
            action: 'showGrammarResult',
            text: info.selectionText,
            result
        });
    } catch (err) {
        chrome.tabs.sendMessage(tab.id, {
            action: 'showGrammarResult',
            text: info.selectionText,
            error: err.message
        });
    }
});

// --- Streaming port (side panel live updates) ---

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'stream') return;

    port.onMessage.addListener(async (req) => {
        if (req.action !== 'streamGrammarCheck' && req.action !== 'streamRephrase') return;

        try {
            const settings = req.settings;
            const apiType = settings.apiType || 'openai';

            let systemPrompt;
            if (req.action === 'streamRephrase') {
                systemPrompt = buildRephrasePrompt();
            } else {
                systemPrompt = buildGrammarPrompt(settings.language, req.domain, settings.goalPreset);
            }

            if (apiType === 'languagetool' && req.action !== 'streamRephrase') {
                // LanguageTool doesn't stream — return full result
                const result = await callLanguageTool(req.text, settings.language);
                port.postMessage({ type: 'chunk', data: result });
                port.postMessage({ type: 'done', data: result });
                return;
            }

            const llmType = resolveLlmType(settings);
            if (!llmType) {
                port.postMessage({ type: 'error', data: 'This feature requires an LLM provider.' });
                return;
            }

            await streamLLM(req.text, settings, systemPrompt, (chunk) => {
                try { port.postMessage({ type: 'chunk', data: chunk }); } catch (_) {}
            });

            port.postMessage({ type: 'done' });
        } catch (err) {
            try { port.postMessage({ type: 'error', data: err.message }); } catch (_) {}
        }
    });
});

// --- Message router ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const handler = MESSAGE_HANDLERS[request.action];
    if (handler) {
        handler(request, sender)
            .then(sendResponse)
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }
});

const MESSAGE_HANDLERS = {
    async grammarCheck(req) {
        const result = await handleGrammarCheck(req.text, req.settings, req.domain);
        return { success: true, result };
    },
    async testConnection(req) {
        const result = await testConnection(req.settings);
        return { success: true, result };
    },
    async rewriteText(req) {
        const result = await callLLM(req.text, req.settings, buildRewritePrompt(req.style));
        return { success: true, result };
    },
    async detectTone(req) {
        const result = await callLLM(req.text, req.settings, buildTonePrompt());
        return { success: true, result };
    },
    async translateText(req) {
        let maxTokens = computeTranslateMaxTokens(req.text);
        let prompt;
        // Use learning prompt if learning mode is enabled
        if (req.learningMode) {
            prompt = buildTranslateLearningPrompt(req.sourceLang, req.targetLang, req.context, req.pageTitle);
            // Increase token budget for learning mode (includes examples + vocabulary)
            maxTokens = Math.min(Math.max(2500, maxTokens * 1.5), 6000);
        } else {
            prompt = buildTranslatePrompt(req.sourceLang, req.targetLang, req.context, req.pageTitle);
        }
        const result = await callLLM(req.text, req.settings, prompt, maxTokens);
        return { success: true, result };
    },
    async rephraseText(req) {
        const result = await callLLM(req.text, req.settings, buildRephrasePrompt());
        return { success: true, result };
    },
    async clipboardCheck(req) {
        const result = await handleGrammarCheck(req.text, req.settings, req.domain);
        return { success: true, result };
    },
    async logMistake(req) {
        try {
            chrome.runtime.sendNativeMessage(
                'com.openclaw.englishteacher', 
                { action: 'logMistake', incorrect: req.incorrect, correct: req.correct }
            );
        } catch (_) {}
        // Also feed the in-extension analytics dashboard.
        try {
            await recordMistakes([{ incorrect: req.incorrect, correct: req.correct, reason: req.reason }]);
        } catch (_) {}
        return { success: true };
    },
    async updateBadge(req, sender) {
        const count = req.count || 0;
        const tabId = sender.tab?.id;
        if (tabId) {
            chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId });
            chrome.action.setBadgeBackgroundColor({ color: '#e74c3c', tabId });
        }
        return { success: true };
    },
    async saveHistory(req) {
        await saveHistoryEntry(req.entry);
        return { success: true };
    },
    async getHistory() {
        const { history } = await chrome.storage.local.get(['history']);
        return { success: true, history: history || [] };
    },
    async clearHistory() {
        await chrome.storage.local.set({ history: [] });
        return { success: true };
    },
    async getSessionStats() {
        await hydrateStats();
        return { success: true, stats: sessionStats };
    },
    async incrementStat(req) {
        await hydrateStats();
        if (req.key && req.key in sessionStats) {
            sessionStats[req.key] += (req.amount || 1);
            persistStats();
        }
        return { success: true, stats: sessionStats };
    },
    async getAnalytics() {
        const data = await getAnalyticsData();
        return { success: true, analytics: data };
    },
    async clearAnalytics() {
        await chrome.storage.local.set({ errorAnalytics: { byType: {}, topMistakes: {}, total: 0 } });
        return { success: true };
    },
    async getSynonyms(req) {
        const result = await callLLM(req.text, req.settings, buildSynonymPrompt(req.word, req.context), 300);
        return { success: true, result };
    },
    async explainWord(req) {
        // Use a slightly larger max token count for the detailed explanation
        const result = await callLLM(req.text, req.settings, buildExplainPrompt(req.targetLang), 800);
        return { success: true, result };
    }
};

// --- Error analytics (persisted to storage.local for the dashboard) ---

async function getAnalyticsData() {
    const { errorAnalytics } = await chrome.storage.local.get('errorAnalytics');
    return errorAnalytics || { byType: {}, topMistakes: {}, total: 0 };
}

function classifyError(incorrect, correct, reason) {
    const r = (reason || '').toLowerCase();
    if (/spell|typo|misspell/.test(r)) return 'spelling';
    if (/capital|uppercase|lowercase/.test(r)) return 'capitalization';
    if (/punctuation|comma|period|apostrophe|space/.test(r)) return 'punctuation';
    if (/tense|verb|agreement|plural|article|preposition|grammar/.test(r)) return 'grammar';
    if (incorrect && correct && incorrect.toLowerCase() === correct.toLowerCase()) return 'capitalization';
    return 'other';
}

async function recordMistakes(edits) {
    if (!edits || edits.length === 0) return;
    const data = await getAnalyticsData();
    for (const e of edits) {
        const cat = classifyError(e.incorrect, e.correct, e.reason);
        data.byType[cat] = (data.byType[cat] || 0) + 1;
        const key = `${e.incorrect} → ${e.correct}`;
        data.topMistakes[key] = (data.topMistakes[key] || 0) + 1;
        data.total++;
    }
    // Cap topMistakes map size to avoid unbounded growth.
    const entries = Object.entries(data.topMistakes);
    if (entries.length > 200) {
        entries.sort((a, b) => b[1] - a[1]);
        data.topMistakes = Object.fromEntries(entries.slice(0, 200));
    }
    await chrome.storage.local.set({ errorAnalytics: data });
}

// --- Prompt builders ---

const GOAL_PRESETS = {
    email: 'The text is an email. Favor a clear, professional, courteous tone.',
    casual: 'The text is casual/social. Keep it relaxed and natural; do not over-formalize.',
    academic: 'The text is academic. Expect formal register, precise word choice, and full sentences.',
    creative: 'The text is creative writing. Preserve voice and style; flag only clear errors.',
    business: 'The text is business communication. Favor concise, confident, professional phrasing.'
};

function getContextHint(domain, goalPreset) {
    let hint = '';
    if (goalPreset && GOAL_PRESETS[goalPreset]) {
        hint += `\nGoal: ${GOAL_PRESETS[goalPreset]}`;
    }
    if (domain) {
        try {
            const hostname = new URL(domain).hostname;
            for (const [key, ctx] of Object.entries(DOMAIN_CONTEXTS)) {
                if (hostname.includes(key)) {
                    hint += `\nContext: The user is writing ${ctx}. Adjust feedback accordingly.`;
                    break;
                }
            }
        } catch {}
    }
    return hint;
}

function buildGrammarPrompt(language, domain, goalPreset) {
    const lang = language || 'English';
    const langLine = lang.toLowerCase() === 'auto'
        ? 'Detect the language and check accordingly.'
        : `Check the following ${lang} text.`;

    return [
        `You are a grammar and spelling checker. ${langLine}`,
        '',
        'If there ARE errors, use EXACTLY this format for each one:',
        '❌ "incorrect text" → ✅ "correct text"',
        'Reason: brief explanation',
        '',
        'If there are NO errors, respond with ONLY this exact line:',
        '✓ No errors found.',
        '',
        'Rules:',
        '- Only flag grammar, spelling, or punctuation errors',
        '- Do not change meaning, tone, or style',
        '- Be concise',
        '- Do NOT introduce yourself or add any commentary',
        '- Your entire response must be ONLY the error list OR "✓ No errors found."',
        getContextHint(domain, goalPreset)
    ].join('\n');
}

function buildRewritePrompt(style) {
    const instructions = {
        formal: 'Rewrite in a formal, professional tone suitable for business communication.',
        casual: 'Rewrite in a casual, conversational tone.',
        concise: 'Make the text more concise while preserving the complete meaning.',
        friendly: 'Rewrite in a warm, friendly, approachable tone.',
        academic: 'Rewrite in an academic, scholarly tone with precise language.',
        simple: 'Simplify the text for easy understanding. Use short sentences and common words.'
    };

    return [
        `You are a writing assistant. ${instructions[style] || instructions.formal}`,
        '',
        'Rules:',
        '- Preserve the original meaning completely',
        '- Improve clarity and flow',
        '- Return ONLY the rewritten text, nothing else',
        '- Do not add explanations or meta-commentary'
    ].join('\n');
}

function buildRephrasePrompt() {
    return [
        'You are a writing assistant. Provide EXACTLY 3 alternative phrasings of the given text.',
        '',
        'Use EXACTLY this format:',
        '1. [first alternative]',
        '2. [second alternative]',
        '3. [third alternative]',
        '',
        'Rules:',
        '- Each alternative must preserve the original meaning',
        '- Vary the style, sentence structure, or vocabulary meaningfully between options',
        '- Return ONLY the numbered list, nothing else',
        '- No meta-commentary, no introduction'
    ].join('\n');
}

function buildTonePrompt() {
    return [
        'Analyze the tone of the following text. Respond in EXACTLY this format:',
        '',
        'Tone: [primary tone]',
        'Confidence: [High/Medium/Low]',
        'Analysis: [1-2 sentence explanation]',
        'Suggestion: [optional short suggestion to improve tone, or "None"]',
        '',
        'Possible tones: Professional, Casual, Friendly, Formal, Assertive, Aggressive,',
        'Passive-aggressive, Enthusiastic, Neutral, Sarcastic, Empathetic, Apologetic, Persuasive'
    ].join('\n');
}

function buildTranslatePrompt(sourceLang, targetLang, context, pageTitle) {
    const src = sourceLang === 'auto' ? 'the detected source language' : sourceLang;
    const safeContext = GC.sanitizeContext(context, 450);
    const safeTitle = GC.sanitizeContext(pageTitle, 150);

    const contextBlock = [];
    if (safeTitle) {
        contextBlock.push(`Page topic: "${safeTitle}"`);
    }
    if (safeContext) {
        contextBlock.push(`Surrounding context on the page:\n"${safeContext}"`);
    }
    const contextSection = contextBlock.length > 0
        ? [
            'IMPORTANT — Use the following context to resolve any ambiguous or polysemous words.',
            'A single word can have many meanings; pick the one that fits the context.',
            ...contextBlock,
            ''
          ].join('\n')
        : '';

    return [
        contextSection,
        `Translate the TEXT TO TRANSLATE below from ${src} to ${targetLang}.`,
        'Provide ONLY the translation. Do not repeat the original text.',
        '',
        'Respond in EXACTLY this format:',
        '',
        '--- Translation ---',
        '[translated text here]',
        '',
        '--- Grammar Check ---',
        '[Use ❌ "incorrect" → ✅ "correct" format for errors, or "✓ No errors found."]'
    ].join('\n');
}

function buildTranslateLearningPrompt(sourceLang, targetLang, context, pageTitle) {
    const src = sourceLang === 'auto' ? 'the detected source language' : sourceLang;
    const nativeLang = sourceLang && sourceLang !== 'auto' ? sourceLang : 'the user\'s native language';
    const safeContext = GC.sanitizeContext(context, 450);
    const safeTitle = GC.sanitizeContext(pageTitle, 150);

    const contextBlock = [];
    if (safeTitle) {
        contextBlock.push(`Page topic: "${safeTitle}"`);
    }
    if (safeContext) {
        contextBlock.push(`Surrounding context on the page:\n"${safeContext}"`);
    }
    const contextSection = contextBlock.length > 0
        ? [
            'IMPORTANT — Use the following context to resolve any ambiguous or polysemous words.',
            'A single word can have many meanings; pick the one that fits the context.',
            ...contextBlock,
            ''
          ].join('\n')
        : '';

    return [
        contextSection,
        `Translate from ${src} to ${targetLang}. The user is learning professional English.`,
        '',
        'Respond in EXACTLY this format with all 4 sections:',
        '',
        '--- Translation ---',
        '[translated text here]',
        '',
        '--- Grammar Check ---',
        '[Use ❌ "incorrect" → ✅ "correct" format for errors, or "✓ No errors found."]',
        '',
        '--- Learning Examples ---',
        'Provide 3 professional/business usage examples demonstrating key phrases from the translation:',
        '  1. [Example sentence 1 in English with business context]',
        '     (' + nativeLang + ' translation: [translation of example 1])',
        '  2. [Example sentence 2 in English with business context]',
        '     (' + nativeLang + ' translation: [translation of example 2])',
        '  3. [Example sentence 3 in English with business context]',
        '     (' + nativeLang + ' translation: [translation of example 3])',
        '',
        '--- Vocabulary ---',
        'Break down 3-5 key vocabulary words from the translation with etymology and synonyms:',
        '  • Word: [word]',
        '    Part of Speech: [noun/verb/adjective/etc]',
        '    Definition: [concise English definition]',
        '    ' + nativeLang + ': [translation]',
        '    Etymology: [brief origin/root if applicable]',
        '    Related Terms: [synonyms or related professional terms]'
    ].join('\n');
}

function buildExplainPrompt(targetLang) {
    const lang = targetLang || 'English';
    return [
        `You are an expert English language teacher. The user has selected a word or short phrase.`,
        `Your task is to provide a comprehensive explanation to help the user learn and understand it.`,
        ``,
        `IMPORTANT: Provide the explanation in a bilingual format:`,
        `- Core structural headings in English`,
        `- English definitions followed by ${lang} translations in parentheses or alongside`,
        `- Explanations and notes in ${lang} to ensure the user fully understands`,
        ``,
        `Respond EXACTLY in this format (use the exact emojis and headings):`,
        ``,
        `📖 Word: [The word/phrase]`,
        `🔤 Pronunciation: [IPA pronunciation]`,
        `📝 Part of Speech: [noun/verb/adjective/etc.]`,
        `💡 Meaning: [Clear explanation in English and ${lang}]`,
        ``,
        `📌 Examples:`,
        `  1. [Example sentence 1 in English]`,
        `     ([Translation of example 1 in ${lang}])`,
        `  2. [Example sentence 2 in English]`,
        `     ([Translation of example 2 in ${lang}])`,
        `  3. [Example sentence 3 in English]`,
        `     ([Translation of example 3 in ${lang}])`,
        ``,
        `🎯 When to Use:`,
        `  - [Bullet points explaining context, formality, and usage nuances in ${lang}]`,
        ``,
        `⚠️ Common Mistakes (Optional):`,
        `  - [Common spelling, grammar, or usage mistakes related to this word, if any]`
    ].join('\n');
}

function buildSynonymPrompt(word, context) {
    const safeContext = GC.sanitizeContext(context, 200);
    return [
        `You are a thesaurus. Provide synonyms or better word choices for the word/phrase: "${word}".`,
        safeContext ? `It appears in this context: "${safeContext}". Pick synonyms that fit this context.` : '',
        '',
        'Respond with ONLY a comma-separated list of 4-6 alternatives, best first.',
        'No numbering, no explanations, no quotes around the list.'
    ].filter(Boolean).join('\n');
}

// --- Result merging for hybrid mode ---

// --- Result merging for hybrid mode (delegated to grammar-core) ---

function mergeGrammarResults(ltResult, llmResult) {
    return GC.mergeGrammarResults(ltResult, llmResult);
}

// --- Core handlers ---

async function handleGrammarCheck(text, settings, domain) {
    await hydrateCache();
    await hydrateStats();
    const apiType = settings.apiType || 'openai';
    const cached = getCached(text, apiType);
    if (cached) return cached;

    let result;
    try {
        if (apiType === 'languagetool') {
            result = await callLanguageTool(text, settings.language);
        } else if (apiType === 'hybrid') {
            result = await handleHybridCheck(text, settings, domain);
        } else {
            // Rate limit pure-LLM grammar checks (cost guard).
            checkRateLimit(settings.rateLimitPerMin);
            result = await callLLM(text, settings, buildGrammarPrompt(settings.language, domain, settings.goalPreset));
        }
    } catch (err) {
        // Offline-first fallback: if the network/API is unreachable, run the
        // local rule checker so the extension is never completely dead.
        if (isNetworkError(err)) {
            result = GC.offlineCheck(text);
        } else {
            throw err;
        }
    }

    sessionStats.checksRun++;

    // Count + record errors found.
    const edits = GC.parseErrors(result);
    sessionStats.errorsFound += edits.length;
    persistStats();
    if (edits.length > 0 && !GC.isOfflineResult(result)) {
        recordMistakes(edits).catch(() => {});
    }

    setCache(text, apiType, result);
    return result;
}

function isNetworkError(err) {
    const m = (err && err.message || '').toLowerCase();
    return m.includes('cannot reach') || m.includes('failed to fetch') ||
           m.includes('networkerror') || m.includes('network error') ||
           m.includes('load failed');
}

async function handleHybridCheck(text, settings, domain) {
    const llmSettings = { ...settings, apiType: settings.hybridLlmType || 'openai' };

    // Apply rate limit to the LLM half of hybrid; if exceeded, fall back to LT-only.
    let llmAllowed = true;
    try { checkRateLimit(settings.rateLimitPerMin); } catch (_) { llmAllowed = false; }

    const tasks = [callLanguageTool(text, settings.language)];
    if (llmAllowed) {
        tasks.push(callLLM(text, llmSettings, buildGrammarPrompt(settings.language, domain, settings.goalPreset)));
    }

    const settled = await Promise.allSettled(tasks);
    const lt = settled[0].status === 'fulfilled' ? settled[0].value : null;
    const llm = settled[1] && settled[1].status === 'fulfilled' ? settled[1].value : null;

    if (!lt && !llm) {
        const err = settled[1]?.reason?.message || settled[0].reason?.message || 'Both APIs failed';
        throw new Error(err);
    }

    return mergeGrammarResults(lt, llm);
}

// --- Unified LLM caller ---

function computeMaxTokens(text) {
    return Math.min(Math.max(500, Math.ceil(text.length / 2)), 2000);
}

// Translation needs extra room:
//   - Output = "--- Translation ---" header + translated text (can be longer than source in verbose languages)
//             + "--- Grammar Check ---" header + grammar results
//   - 1 token ≈ 4 chars for English; Vietnamese/Thai etc. can use more tokens per character
//   - Formula: 2× estimated input tokens + 500 overhead, min 1500, max 4000
function computeTranslateMaxTokens(text) {
    const estimatedInputTokens = Math.ceil(text.length / 4);
    return Math.min(Math.max(1500, estimatedInputTokens * 2 + 500), 4000);
}

function resolveLlmType(settings) {
    const t = settings.apiType || 'openai';
    if (t === 'hybrid') return settings.hybridLlmType || 'openai';
    if (t === 'languagetool') return null;
    return t;
}

async function callLLM(text, settings, systemPrompt, maxTokens) {
    const llmType = resolveLlmType(settings);
    if (!llmType) throw new Error('This feature requires an LLM provider. Change provider in Settings.');
    if (llmType === 'openai') return await callOpenAI(text, settings, systemPrompt, maxTokens);
    return await callCustomAPI(text, settings, systemPrompt, maxTokens);
}

// --- Streaming LLM ---

async function streamLLM(text, settings, systemPrompt, onChunk) {
    const llmType = resolveLlmType(settings);
    if (!llmType) throw new Error('This feature requires an LLM provider.');
    if (llmType === 'openai') return await streamOpenAI(text, settings, systemPrompt, onChunk);
    return await streamCustomAPI(text, settings, systemPrompt, onChunk);
}

async function streamOpenAI(text, settings, systemPrompt, onChunk) {
    if (!settings.openaiApiKey) throw new Error('OpenAI API key not configured.');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.openaiApiKey}`
        },
        body: JSON.stringify({
            model: settings.openaiModel || 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ],
            temperature: 0.3,
            max_tokens: computeMaxTokens(text),
            stream: true
        })
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI API ${response.status}: ${body}`);
    }

    return await readSSEStream(response, onChunk);
}

async function streamCustomAPI(text, settings, systemPrompt, onChunk) {
    if (!settings.localUrl || !settings.localModel) throw new Error('API endpoint not configured.');

    let url = settings.localUrl.replace(/\/+$/, '');
    if (!url.endsWith('/chat/completions')) {
        try {
            const u = new URL(url);
            u.pathname = '/v1/chat/completions';
            url = u.toString();
        } catch {
            url = url.split('/').slice(0, 3).join('/') + '/v1/chat/completions';
        }
    }

    const headers = { 'Content-Type': 'application/json' };
    if (settings.localApiKey) headers['Authorization'] = `Bearer ${settings.localApiKey}`;

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: settings.localModel,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ],
            temperature: 0.3,
            max_tokens: computeMaxTokens(text),
            stream: true
        })
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`API ${response.status}: ${body}`);
    }

    return await readSSEStream(response, onChunk);
}

async function readSSEStream(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') continue;
            if (!trimmed.startsWith('data: ')) continue;

            try {
                const json = JSON.parse(trimmed.slice(6));
                const delta = json.choices?.[0]?.delta?.content;
                if (delta) {
                    fullText += delta;
                    onChunk(delta);
                }
            } catch (_) {}
        }
    }

    return fullText;
}

async function callOpenAI(text, settings, systemPrompt, maxTokens) {
    if (!settings.openaiApiKey) {
        throw new Error('OpenAI API key not configured. Go to extension Options.');
    }

    let response;
    try {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.openaiApiKey}`
            },
            body: JSON.stringify({
                model: settings.openaiModel || 'gpt-4o',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: text }
                ],
                temperature: 0.3,
                max_tokens: maxTokens || computeMaxTokens(text)
            })
        });
    } catch (e) {
        throw new Error(`Cannot reach OpenAI API. (${e.message})`);
    }

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI API ${response.status}: ${body}`);
    }

    const data = await response.json();
    if (!data.choices?.[0]?.message?.content) throw new Error('Invalid OpenAI response');
    return data.choices[0].message.content;
}

async function callCustomAPI(text, settings, systemPrompt, maxTokens) {
    if (!settings.localUrl || !settings.localModel) {
        throw new Error('API endpoint not configured. Go to extension Options.');
    }

    let url = settings.localUrl.replace(/\/+$/, '');
    if (!url.endsWith('/chat/completions')) {
        try {
            const u = new URL(url);
            u.pathname = '/v1/chat/completions';
            url = u.toString();
        } catch {
            url = url.split('/').slice(0, 3).join('/') + '/v1/chat/completions';
        }
    }

    const headers = { 'Content-Type': 'application/json' };
    if (settings.localApiKey) headers['Authorization'] = `Bearer ${settings.localApiKey}`;

    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: settings.localModel,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: text }
                ],
                temperature: 0.3,
                max_tokens: maxTokens || computeMaxTokens(text),
                stream: false
            })
        });
    } catch (e) {
        throw new Error(`Cannot reach ${url}. (${e.message})`);
    }

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`API ${response.status}: ${body}`);
    }

    const data = await response.json();
    if (!data.choices?.[0]?.message?.content) throw new Error('Invalid API response');
    return data.choices[0].message.content;
}

// --- LanguageTool API (free, fast ~100-300ms) ---

async function callLanguageTool(text, language) {
    const langCode = LANG_CODE_MAP[language] || 'auto';

    const params = new URLSearchParams();
    params.append('text', text);
    params.append('language', langCode);
    params.append('enabledOnly', 'false');

    let response;
    try {
        response = await fetch('https://api.languagetool.org/v2/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });
    } catch (e) {
        throw new Error(`Cannot reach LanguageTool API. (${e.message})`);
    }

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`LanguageTool API ${response.status}: ${body}`);
    }

    const data = await response.json();

    // Attach detected language info as a special comment line
    const detectedLang = data.language?.detectedLanguage?.code || data.language?.code || null;
    let langLine = '';
    if (detectedLang) {
        const info = LANG_DISPLAY[detectedLang] || LANG_DISPLAY[detectedLang.split('-')[0]] || null;
        if (info) {
            langLine = `[DETECTED_LANG:${detectedLang}:${info.flag}:${info.name}]\n`;
        }
    }

    if (!data.matches || data.matches.length === 0) {
        return langLine + '✓ No errors found.';
    }

    const errorLines = data.matches.map(m => {
        const incorrect = text.substring(m.offset, m.offset + m.length);
        const correct = m.replacements?.[0]?.value || incorrect;
        const reason = m.message || '';
        return `❌ "${incorrect}" → ✅ "${correct}"\nReason: ${reason}`;
    }).join('\n\n');

    return langLine + errorLines;
}

// --- Test connection ---

async function testConnection(settings) {
    const apiType = settings.apiType || 'openai';

    if (apiType === 'languagetool' || apiType === 'hybrid') {
        const ltRes = await fetch('https://api.languagetool.org/v2/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ text: 'This is an test.', language: 'en-US' }).toString()
        });
        if (!ltRes.ok) throw new Error(`LanguageTool returned ${ltRes.status}`);
        if (apiType === 'languagetool') return 'Connected to LanguageTool API (free tier)';

        const hybridType = settings.hybridLlmType || 'openai';
        const llmResult = await testConnection({ ...settings, apiType: hybridType });
        return `Hybrid OK: LanguageTool + ${llmResult}`;
    }

    if (apiType === 'openai') {
        if (!settings.openaiApiKey) throw new Error('API key not set');
        const res = await fetch('https://api.openai.com/v1/models', {
            headers: { 'Authorization': `Bearer ${settings.openaiApiKey}` }
        });
        if (!res.ok) throw new Error(`OpenAI returned ${res.status}`);
        return 'Connected to OpenAI API';
    }

    let url = (settings.localUrl || '').replace(/\/+$/, '');
    url = url.replace(/\/chat\/completions$/, '/models');
    if (!url.includes('/models')) {
        try {
            const u = new URL(url);
            u.pathname = '/v1/models';
            url = u.toString();
        } catch {
            throw new Error('Invalid URL: ' + settings.localUrl);
        }
    }

    const headers = {};
    if (settings.localApiKey) headers['Authorization'] = `Bearer ${settings.localApiKey}`;

    let res;
    try {
        res = await fetch(url, { headers });
    } catch (e) {
        throw new Error(`Cannot reach ${url} (${e.message}). Is the server running?`);
    }
    if (!res.ok) throw new Error(`Server returned ${res.status} at ${url}`);
    return `Connected to ${settings.localUrl}`;
}

// --- History ---

async function saveHistoryEntry(entry) {
    const { history = [] } = await chrome.storage.local.get(['history']);
    if (history.length > 0 && history[0].text === entry.text && history[0].result === entry.result) return;
    history.unshift({ ...entry, id: Date.now(), timestamp: Date.now() });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    await chrome.storage.local.set({ history });
}
