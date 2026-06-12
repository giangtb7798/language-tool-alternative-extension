// Shared text-to-speech helper for extension UI pages (popup, side panel)
(function(global) {
    'use strict';

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

    let activeBtn = null;
    const defaultLabels = { idle: '🔊 Read', active: '⏹ Stop' };

    function resetButton() {
        if (!activeBtn) return;
        activeBtn.classList.remove('gc-speaking');
        activeBtn.textContent = activeBtn.dataset.idleLabel || defaultLabels.idle;
        activeBtn = null;
    }

    function pickVoice(langCode) {
        const voices = global.speechSynthesis.getVoices();
        if (!voices.length) return null;
        const prefix = langCode.split('-')[0].toLowerCase();
        return voices.find(v => v.lang.toLowerCase().startsWith(prefix))
            || voices.find(v => v.default)
            || voices[0];
    }

    function stop() {
        if (global.speechSynthesis) global.speechSynthesis.cancel();
        resetButton();
    }

    function speak(text, options = {}) {
        if (!global.speechSynthesis) {
            return { ok: false, error: 'Text-to-speech is not supported' };
        }

        const trimmed = (text || '').trim();
        if (!trimmed) return { ok: false, error: 'No text to read' };

        if (options.button && options.button.classList.contains('gc-speaking')) {
            stop();
            return { ok: true, stopped: true };
        }

        stop();

        const langCode = SPEAK_LANG_MAP[options.language] || options.langCode || 'en-US';
        const rate = typeof options.rate === 'number' ? options.rate : 0.95;
        const btn = options.button || null;

        const start = () => {
            const utterance = new SpeechSynthesisUtterance(trimmed);
            utterance.lang = langCode;
            utterance.rate = rate;
            const voice = pickVoice(langCode);
            if (voice) utterance.voice = voice;

            if (btn) {
                activeBtn = btn;
                btn.classList.add('gc-speaking');
                btn.textContent = btn.dataset.activeLabel || defaultLabels.active;
            }

            utterance.onend = resetButton;
            utterance.onerror = resetButton;
            global.speechSynthesis.speak(utterance);
        };

        if (global.speechSynthesis.getVoices().length === 0) {
            global.speechSynthesis.addEventListener('voiceschanged', start, { once: true });
            global.speechSynthesis.getVoices();
        } else {
            start();
        }

        return { ok: true };
    }

    if (global.speechSynthesis) global.speechSynthesis.getVoices();

    global.GCSpeak = { speak, stop, SPEAK_LANG_MAP };
})(typeof window !== 'undefined' ? window : self);
