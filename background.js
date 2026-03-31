// Background service worker v8.0.0

const SETTINGS_KEYS = [
    'apiType', 'hybridLlmType', 'openaiApiKey', 'openaiModel',
    'localUrl', 'localModel', 'localApiKey', 'language'
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
const grammarCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX_SIZE = 200;

function hashText(text) {
    let h1 = 0, h2 = 0x5a827999;
    for (let i = 0; i < text.length; i++) {
        h1 = ((h1 << 5) - h1) + text.charCodeAt(i); h1 |= 0;
        h2 = ((h2 << 5) + h2) ^ text.charCodeAt(text.length - 1 - i); h2 |= 0;
    }
    return h1.toString(36) + '_' + h2.toString(36) + '_' + text.length;
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

// --- Session statistics (in-memory, reset on service worker restart) ---
let sessionStats = {
    checksRun: 0,
    errorsFound: 0,
    errorsFixed: 0,
    startTime: Date.now()
};

// --- Setup ---

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'checkGrammar',
        title: 'Check Grammar',
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
    if (info.menuItemId !== 'checkGrammar' || !info.selectionText) return;

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
                systemPrompt = buildGrammarPrompt(settings.language, req.domain);
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
        const result = await callLLM(req.text, req.settings, buildTranslatePrompt(req.sourceLang, req.targetLang));
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
        return { success: true, stats: sessionStats };
    },
    async incrementStat(req) {
        if (req.key && req.key in sessionStats) {
            sessionStats[req.key] += (req.amount || 1);
        }
        return { success: true, stats: sessionStats };
    }
};

// --- Prompt builders ---

function getContextHint(domain) {
    if (!domain) return '';
    try {
        const hostname = new URL(domain).hostname;
        for (const [key, ctx] of Object.entries(DOMAIN_CONTEXTS)) {
            if (hostname.includes(key)) {
                return `\nContext: The user is writing ${ctx}. Adjust feedback accordingly.`;
            }
        }
    } catch {}
    return '';
}

function buildGrammarPrompt(language, domain) {
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
        getContextHint(domain)
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

function buildTranslatePrompt(sourceLang, targetLang) {
    const src = sourceLang === 'auto' ? 'the detected source language' : sourceLang;
    return [
        `Translate the following text from ${src} to ${targetLang}.`,
        'Then check the translation for grammar errors.',
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

// --- Result merging for hybrid mode ---

function parseErrorsFromResult(result) {
    if (!result) return [];
    const errors = [];
    const matches = Array.from(result.matchAll(/❌\s*"([^"]+)"\s*→\s*✅\s*"([^"]+)"/g));
    const reasons = Array.from(result.matchAll(/Reason:\s*(.+)/gi));
    matches.forEach((m, i) => {
        errors.push({ incorrect: m[1], correct: m[2], reason: reasons[i]?.[1] || '' });
    });
    return errors;
}

function resultIsClean(r) {
    if (!r) return true;
    const low = r.toLowerCase();
    return r.includes('✓') || low.includes('no error') || low.includes('no issue') ||
           low.includes('no mistake') || low.includes('grammatically correct');
}

function mergeGrammarResults(ltResult, llmResult) {
    if (!ltResult && !llmResult) return '✓ No errors found.';
    if (!ltResult) return llmResult;
    if (!llmResult) return ltResult;

    if (resultIsClean(ltResult) && resultIsClean(llmResult)) return '✓ No errors found.';

    const ltErrors = parseErrorsFromResult(ltResult);
    const llmErrors = parseErrorsFromResult(llmResult);

    const merged = new Map();
    for (const err of llmErrors) merged.set(err.incorrect.toLowerCase(), err);
    for (const err of ltErrors) {
        const key = err.incorrect.toLowerCase();
        if (!merged.has(key)) merged.set(key, err);
    }

    if (merged.size === 0) {
        if (!resultIsClean(llmResult)) return llmResult;
        if (!resultIsClean(ltResult)) return ltResult;
        return '✓ No errors found.';
    }

    return Array.from(merged.values()).map(e => {
        let line = `❌ "${e.incorrect}" → ✅ "${e.correct}"`;
        if (e.reason) line += `\nReason: ${e.reason}`;
        return line;
    }).join('\n\n');
}

// --- Core handlers ---

async function handleGrammarCheck(text, settings, domain) {
    const apiType = settings.apiType || 'openai';
    const cached = getCached(text, apiType);
    if (cached) return cached;

    sessionStats.checksRun++;

    let result;
    if (apiType === 'languagetool') {
        result = await callLanguageTool(text, settings.language);
    } else if (apiType === 'hybrid') {
        result = await handleHybridCheck(text, settings, domain);
    } else {
        result = await callLLM(text, settings, buildGrammarPrompt(settings.language, domain));
    }

    // Count errors found
    const errorMatches = Array.from((result || '').matchAll(/❌/g));
    sessionStats.errorsFound += errorMatches.length;

    setCache(text, apiType, result);
    return result;
}

async function handleHybridCheck(text, settings, domain) {
    const llmSettings = { ...settings, apiType: settings.hybridLlmType || 'openai' };

    const [ltSettled, llmSettled] = await Promise.allSettled([
        callLanguageTool(text, settings.language),
        callLLM(text, llmSettings, buildGrammarPrompt(settings.language, domain))
    ]);

    const lt = ltSettled.status === 'fulfilled' ? ltSettled.value : null;
    const llm = llmSettled.status === 'fulfilled' ? llmSettled.value : null;

    if (!lt && !llm) {
        const err = llmSettled.reason?.message || ltSettled.reason?.message || 'Both APIs failed';
        throw new Error(err);
    }

    return mergeGrammarResults(lt, llm);
}

// --- Unified LLM caller ---

function computeMaxTokens(text) {
    return Math.min(Math.max(500, Math.ceil(text.length / 2)), 2000);
}

function resolveLlmType(settings) {
    const t = settings.apiType || 'openai';
    if (t === 'hybrid') return settings.hybridLlmType || 'openai';
    if (t === 'languagetool') return null;
    return t;
}

async function callLLM(text, settings, systemPrompt) {
    const llmType = resolveLlmType(settings);
    if (!llmType) throw new Error('This feature requires an LLM provider. Change provider in Settings.');
    if (llmType === 'openai') return await callOpenAI(text, settings, systemPrompt);
    return await callCustomAPI(text, settings, systemPrompt);
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

async function callOpenAI(text, settings, systemPrompt) {
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
                max_tokens: computeMaxTokens(text)
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

async function callCustomAPI(text, settings, systemPrompt) {
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
                max_tokens: computeMaxTokens(text),
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
