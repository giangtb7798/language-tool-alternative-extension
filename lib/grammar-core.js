// grammar-core.js — pure, dependency-free helpers shared by
// background.js, content.js, popup.js and sidepanel.js.
//
// Loaded in the browser via <script>/importScripts (attaches to globalThis.GrammarCore)
// and in Node tests via require() (module.exports). Keep this file SIDE-EFFECT FREE
// apart from the export shim at the bottom — no chrome.* calls, no DOM.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.GrammarCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // --- Detected-language marker handling ---

    const DETECTED_LANG_RE = /\[DETECTED_LANG:([^:]+):([^:]+):([^\]]+)\]/;

    function extractDetectedLang(result) {
        if (!result) return null;
        const m = result.match(DETECTED_LANG_RE);
        if (!m) return null;
        return { code: m[1], flag: m[2], name: m[3] };
    }

    // Strip ALL detected-language marker lines (global flag — the original
    // single-match version leaked extra markers in merged/hybrid results).
    function stripLangLine(result) {
        if (!result) return result;
        return result.replace(/\[DETECTED_LANG:[^\]]+\]\n?/g, '');
    }

    // --- Error parsing ---

    // Parse "❌ "incorrect" → ✅ "correct"" pairs plus their reasons.
    // Returns [{ incorrect, correct, reason }].
    function parseErrors(result) {
        if (!result) return [];
        const clean = stripLangLine(result);
        const pairs = Array.from(clean.matchAll(/❌\s*"([^"]+)"\s*→\s*✅\s*"([^"]+)"/g));
        const reasons = Array.from(clean.matchAll(/Reason:\s*(.+)/gi));
        return pairs.map((m, i) => ({
            incorrect: m[1],
            correct: m[2],
            reason: reasons[i] ? reasons[i][1].trim() : ''
        }));
    }

    // True when the result represents a clean / no-error response.
    function resultIsClean(result) {
        if (!result) return true;
        const low = stripLangLine(result).toLowerCase();
        return result.includes('✓') ||
            low.includes('no error') || low.includes('no issue') ||
            low.includes('no mistake') || low.includes('looks good') ||
            low.includes('grammatically correct') || low.includes('looks correct') ||
            low.includes('well-written');
    }

    // High-level parse used by the UIs. customDictionary words are filtered out.
    function parseGrammarResult(result, customDictionary) {
        const clean = stripLangLine(result || '');
        const parsedErrors = parseErrors(result);
        let errors = parsedErrors;

        if (customDictionary && customDictionary.length > 0) {
            const dict = customDictionary.map(w => String(w).toLowerCase());
            errors = errors.filter(e => !dict.includes(e.incorrect.toLowerCase()));
        }

        const hasExplicitClean = resultIsClean(result);
        const allErrorsFiltered = parsedErrors.length > 0 && errors.length === 0;
        const hasNoMarkers = errors.length === 0 && !clean.includes('❌');
        return {
            isClean: hasExplicitClean || hasNoMarkers || allErrorsFiltered,
            errors,
            raw: clean
        };
    }

    // --- Hybrid merge (LanguageTool + LLM), dedup by incorrect text ---

    function formatErrorLines(errors) {
        return errors.map(e => {
            let line = `❌ "${e.incorrect}" → ✅ "${e.correct}"`;
            if (e.reason) line += `\nReason: ${e.reason}`;
            return line;
        }).join('\n\n');
    }

    function mergeGrammarResults(ltResult, llmResult) {
        if (!ltResult && !llmResult) return '✓ No errors found.';
        if (!ltResult) return llmResult;
        if (!llmResult) return ltResult;
        if (resultIsClean(ltResult) && resultIsClean(llmResult)) return '✓ No errors found.';

        const merged = new Map();
        for (const e of parseErrors(llmResult)) merged.set(e.incorrect.toLowerCase(), e);
        for (const e of parseErrors(ltResult)) {
            const key = e.incorrect.toLowerCase();
            if (!merged.has(key)) merged.set(key, e);
        }

        if (merged.size === 0) {
            if (!resultIsClean(llmResult)) return llmResult;
            if (!resultIsClean(ltResult)) return ltResult;
            return '✓ No errors found.';
        }
        return formatErrorLines(Array.from(merged.values()));
    }

    // --- Offset-aware fix application ---

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Apply a list of {incorrect, correct} edits to `text`.
    // Unlike a naive global replace, this fixes only the FIRST remaining
    // occurrence of each error (and respects word boundaries), so the same
    // word elsewhere in the text is left untouched. Tracks running offsets.
    function applyFixesToText(text, edits) {
        let out = text;
        for (const edit of edits) {
            const inc = edit.incorrect;
            const cor = edit.correct;
            if (!inc) continue;

            const startBound = /^\w/.test(inc) ? '\\b' : '';
            const endBound = /\w$/.test(inc) ? '\\b' : '';
            let re = new RegExp(`${startBound}${escapeRegex(inc)}${endBound}`);
            let m = re.exec(out);
            if (!m) {
                re = new RegExp(`${startBound}${escapeRegex(inc)}${endBound}`, 'i');
                m = re.exec(out);
            }
            if (!m) continue;
            out = out.slice(0, m.index) + cor + out.slice(m.index + m[0].length);
        }
        // Collapse accidental doubled punctuation introduced by fixes.
        out = out.replace(/([,;:!?.])(\1)+/g, '$1');
        return out;
    }

    // --- Prompt-injection sanitizer for page-derived context ---

    // Strip directive-looking lines and delimiters from untrusted page text
    // before it is interpolated into an LLM system prompt.
    function sanitizeContext(text, maxLen) {
        if (!text) return '';
        let s = String(text);
        // Neutralise our own section delimiters and code fences.
        s = s.replace(/-{2,}\s*(translation|grammar check|learning examples|vocabulary)\s*-{2,}/gi, ' ');
        s = s.replace(/```+/g, ' ');
        // Drop lines that look like instructions aimed at the model.
        const injection = /(ignore|disregard|forget)\b.*(previous|above|prior|earlier|instruction|prompt|rule)|you are now|new instructions?:|system prompt|act as|pretend to be/i;
        s = s.split('\n').filter(line => !injection.test(line)).join('\n');
        s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
        const cap = maxLen || 450;
        return s.slice(0, cap);
    }

    // --- Offline rule-based checker (no network) ---
    // A small, conservative set of language-agnostic rules so the extension is
    // never completely dead when the API is unreachable.
    function offlineCheck(text) {
        if (!text || !text.trim()) return '✓ No errors found.';
        const edits = [];
        const seen = new Set();
        const push = (incorrect, correct, reason) => {
            const key = incorrect + '→' + correct;
            if (seen.has(key)) return;
            seen.add(key);
            edits.push({ incorrect, correct, reason });
        };

        // Repeated word: "the the"
        let m;
        const dupRe = /\b(\w+)\s+\1\b/gi;
        while ((m = dupRe.exec(text))) {
            push(m[0], m[1], 'Repeated word.');
        }
        // Double spaces.
        if (/\S  +\S/.test(text)) {
            const dm = text.match(/(\S  +\S)/);
            if (dm) push(dm[1], dm[1].replace(/ +/g, ' '), 'Multiple spaces.');
        }
        // Space before punctuation: "word ,"
        const spaceP = /\s+([,;:!?.])/g;
        while ((m = spaceP.exec(text))) {
            push(m[0], m[1], 'Remove space before punctuation.');
        }
        // Standalone lowercase "i".
        const iRe = /\bi\b/g;
        while ((m = iRe.exec(text))) {
            push('i', 'I', 'Capitalize the pronoun "I".');
            break;
        }

        if (edits.length === 0) return '✓ No errors found.';
        return formatErrorLines(edits) + '\n\n[OFFLINE_FALLBACK]';
    }

    function isOfflineResult(result) {
        return !!result && result.includes('[OFFLINE_FALLBACK]');
    }

    return {
        DETECTED_LANG_RE,
        extractDetectedLang,
        stripLangLine,
        parseErrors,
        resultIsClean,
        parseGrammarResult,
        formatErrorLines,
        mergeGrammarResults,
        escapeRegex,
        applyFixesToText,
        sanitizeContext,
        offlineCheck,
        isOfflineResult
    };
});
