// helpers/kometaTheater.js
// "Kometa Theater" — a silly mode that narrates a Kometa run in-character. Each collection is a
// unit reporting for duty to the server, paced deliberately on Discord's side.
//
// Behaviour:
//   - A collection that is UNSEEN *and* empty (holds no items this run) → garbled STATIC (an
//     unidentified signal). No Gemini. This is the ONLY static case.
//   - Everything else REPORTS IN with dialogue: any collection the bot has met before, plus any
//     unseen collection that actually holds items ("comes alive" and introduces itself). Reports
//     comment on the run's additions/removals when there are any.
//   - "Holds items" is read from the log's "N Movies/Shows Processed" count; when we can't read a
//     count we assume it has content (so a real collection is never wrongly flagged as static).
//   - Each collection has its OWN persona, keyed by its name — every rating tier, every Cage
//     collection, etc. is distinct — minted once via a fast Gemini model and persisted.
//   - No cap: bounded only by how many collections Kometa actually processes.
//
// Data sources: the log (Kometa's meta.log) supplies coverage — one "Finished <Name> Collection"
// line per collection, including unchanged ones — while the clean `changes` webhooks (fed in via
// onChanges) supply the add/remove detail. The only brittle parse is parseFinishedCollection().
//
// Nothing here runs until startKometaTheater() is called, and every async path is guarded so a
// parse/Gemini/Discord hiccup can never crash the bot.
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { EmbedBuilder } = require('discord.js');
const config = require('../config/config.js');
const logger = require('./logger.js');
const { getModel } = require('./geminiAPI.js');

const STORE_PATH = path.join(__dirname, '..', 'data', 'kometa_theater.json');
const QUEUE_PATH = path.join(__dirname, '..', 'data', 'kometa_theater_queue.json');
const GRACE_MS = 3000;   // wait this long after a "Finished" line so its `changes` webhook can arrive
const IDLE_MS = 750;     // poll cadence when the queue is empty

// --- pure helpers (exported for tests) -----------------------------------------------------

// "…| Finished Nicolas Cage Collection |…" -> "Nicolas Cage". Ignores the run-end line
// "Finished Collections Run". Returns null when the line isn't a collection-finished line.
function parseFinishedCollection(line) {
    if (!line || /Finished\s+Collections\s+Run/.test(line)) return null;
    const m = /Finished\s+(.+?)\s+Collection\b/.exec(line);
    if (!m) return null;
    const name = m[1].trim();
    return name || null;
}

// "20 Movies Processed 0 Movies Added" -> { total: 20, added: 0 }. Kometa logs this once per
// collection; we attach the last one seen to the following "Finished <Name> Collection" so we know
// whether that collection actually holds any items.
function parseProcessed(line) {
    const m = /(\d+)\s+\w+\s+Processed\s+(\d+)\s+\w+\s+Added/.exec(line || '');
    if (!m) return null;
    return { total: parseInt(m[1], 10), added: parseInt(m[2], 10) };
}

// Align a log name ("Nicolas Cage") with a webhook name ("The Nicolas Cage Collection").
function normalizeName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/^the\s+/, '')
        .replace(/\s+collection$/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// The whole rule: static ONLY when a collection is both unseen and empty; otherwise it reports in.
// (`hasContent` = it holds items this run / the webhook reported adds / the count was unreadable.)
function classifyKind(isSeen, hasContent) {
    return (!isSeen && !hasContent) ? 'static' : 'report';
}

const COMBINING = ['́', '̀', '̈', '̴', '̰', '̡'];
function garble(str) {
    let out = '';
    for (let i = 0; i < str.length; i++) {
        out += str[i];
        if (str[i] !== ' ') out += COMBINING[(str.charCodeAt(i) + i) % COMBINING.length];
    }
    return out;
}

// Deterministic "no signal" static for an unseen collection (name faintly embedded).
function buildStaticText(name) {
    const tag = garble(String(name || 'UNKNOWN').toUpperCase());
    return `▓▒░  ·· ·  ${tag}  · ·· ░▒▓\n\`[ unidentified signal — no clearance ]\``;
}

// --- module state ---------------------------------------------------------------------------

let _client = null;
let _model = null;
let store = { seen: [], personas: {} };
let seenSet = new Set();
const changeBuffer = new Map(); // norm -> { added:[], removed:[], created, ts }
const genQueue = [];            // raw collections awaiting generation: { name, norm, total, added, readyAt }
let postQueue = [];             // rendered, ready-to-post specs (persisted to disk): { kind, ... }
let generating = false;         // true while a spec is mid-generation (don't end the session under it)
let pendingCounts = null;       // last "N Processed M Added" seen, attached to the next Finished line
let sessionActive = false;
let ending = false;
let produceTimer = null;
let consumeTimer = null;
let stopTailer = null;
let channelCache = null;

// --- persistence ----------------------------------------------------------------------------

function loadStore() {
    try {
        if (fs.existsSync(STORE_PATH)) {
            const o = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
            store = {
                seen: Array.isArray(o.seen) ? o.seen : [],
                personas: o.personas && typeof o.personas === 'object' ? o.personas : {},
            };
        }
    } catch (err) {
        logger.warn('Kometa Theater store load failed:', err.message || err);
        store = { seen: [], personas: {} };
    }
    seenSet = new Set(store.seen);
}

function saveStore() {
    try {
        store.seen = [...seenSet];
        fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
        fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2) + '\n');
    } catch (err) {
        logger.warn('Kometa Theater store save failed:', err.message || err);
    }
}

function markSeen(norm) {
    if (!seenSet.has(norm)) {
        seenSet.add(norm);
        saveStore();
    }
}

// The post queue is persisted so a restart mid-run resumes the already-generated messages.
function loadPostQueue() {
    try {
        if (fs.existsSync(QUEUE_PATH)) {
            const a = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
            if (Array.isArray(a)) return a;
        }
    } catch (err) {
        logger.warn('Kometa Theater queue load failed:', err.message || err);
    }
    return [];
}

function savePostQueue() {
    try {
        fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
        fs.writeFileSync(QUEUE_PATH, JSON.stringify(postQueue));
    } catch (err) {
        logger.warn('Kometa Theater queue save failed:', err.message || err);
    }
}

// --- Gemini (fast model, graceful fallback) -------------------------------------------------

function theaterModel() {
    if (!_model) {
        _model = getModel({
            model: config.kometaTheaterModel || undefined, // blank → geminiAPI DEFAULT_MODEL
            // Moderate temperature keeps voices coherent (high temp was producing nonsense); the
            // generous token budget gives each prompt room to finish instead of being cut short.
            generationConfig: { temperature: 0.9, maxOutputTokens: 1000 },
        });
    }
    return _model;
}

async function ensurePersona(name, norm) {
    if (store.personas[norm]) return store.personas[norm];
    let persona = { callsign: name, vibe: `the living embodiment of "${name}", speaking entirely through that theme` };
    try {
        const prompt = `Invent a VIVID voice for a Plex media collection named "${name}".\n`
            + `The character MUST be derived FROM the collection's own theme — who or what they are comes directly from what "${name}" is about. It does NOT have to be a human "persona": it can be a fitting character, the concept / object / place / holiday itself personified, or the vibe of the category given a voice — whatever fits "${name}" best.\n`
            + `Ideas (do NOT copy): "Valentine's Day" → a breathless hopeless romantic, or a cupid with carpal tunnel; "IMDb Top 250" → an insufferable film-snob who ranks everything; "Mother's Day" → an over-caring mom guilt-tripping the server; "The Nicolas Cage Collection" → a manic Cage superfan.\n`
            + `Make each distinct, never a generic soldier or radio operator, and ALWAYS unmistakably tied to "${name}".\n`
            + `Return ONLY JSON: {"callsign":"<a short, characterful name/handle that fits the theme>","vibe":"<2-3 sentences: who or what they are, their attitude, and how they talk — all rooted in the collection's theme>"}.`;
        const res = await theaterModel().generateContent(prompt);
        const m = res.response.text().match(/\{[\s\S]*\}/);
        if (m) {
            const o = JSON.parse(m[0]);
            if (o.callsign && o.vibe) persona = { callsign: String(o.callsign).slice(0, 80), vibe: String(o.vibe).slice(0, 600) };
        }
    } catch (err) {
        logger.warn(`Kometa Theater persona generation failed for "${name}":`, err.message || err);
    }
    store.personas[norm] = persona;
    saveStore();
    return persona;
}

function titleList(arr, alt) {
    if (!arr || !arr.length) return alt;
    return arr.slice(0, 6).join(', ') + (arr.length > 6 ? `, +${arr.length - 6} more` : '');
}

// Pre-written "transmission cut off" flavor, appended when a reply hits the token limit so a
// truncated line reads as intentional interference rather than a bug.
const CUTOFFS = [
    '—*static swallows the rest of the transmission*—',
    '—*the wind carries the rest of the words away*—',
    '—*[signal lost]*',
    '—*the channel flips to dead air*—',
    '—*bzzzt… the line drops mid-thought*—',
    '—*someone changes the frequency*—',
];
function pickCutoff() {
    return CUTOFFS[Math.floor(Math.random() * CUTOFFS.length)];
}

async function generateReport(persona, ctx, isNew) {
    let context;
    if (ctx.hasChange) {
        const addStr = ctx.addedTitles.length ? titleList(ctx.addedTitles, 'none') : (ctx.addedCount ? `${ctx.addedCount} new` : 'none');
        const remStr = ctx.removedTitles.length ? titleList(ctx.removedTitles, 'none') : 'none';
        context = `This run, these titles were added to you: ${addStr}. Removed: ${remStr}.${ctx.created ? ' You were just created this run.' : ''} React in character to these specific changes.`;
    } else {
        context = `Nothing was added or removed from you this run${ctx.total ? ` — you currently hold ${ctx.total} titles` : ''}. React however your character would to a quiet, uneventful check-in.`;
    }
    const intro = isNew ? 'This is the first time the server has met you — introduce yourself in your own unmistakable style. ' : '';
    try {
        const prompt = `You ARE this character. Name/handle: "${persona.callsign}". Persona: ${persona.vibe}\n`
            + `You are the voice of a Plex media collection. The server just checked on you during a library update.\n`
            + `${intro}${context}\n`
            + `Respond ENTIRELY as this character — let their personality and voice completely dominate, and keep it rooted in their theme. Do NOT default to a military "reporting for duty" or "callsign reporting in" format unless that is truly who they are.\n`
            + `Write 2-3 complete, coherent sentences (~200-400 characters), plain text, addressed to the server. No markdown, no quotes, no stage directions.`;
        const res = await theaterModel().generateContent(prompt);
        let t = res.response.text().trim();
        if (t) {
            const cand = res.response && res.response.candidates && res.response.candidates[0];
            const truncated = cand && cand.finishReason === 'MAX_TOKENS';
            t = t.slice(0, 900);
            if (truncated) t += ' ' + pickCutoff(); // it got cut off — make it read intentional
            return t;
        }
    } catch (err) {
        logger.warn('Kometa Theater line generation failed:', err.message || err);
    }
    // Gemini unavailable → an atmospheric "signal lost" line rather than a flat callsign report.
    if (ctx.hasChange) {
        return `${persona.callsign} — the signal garbles just as ${ctx.addedCount} arrive and ${ctx.removedTitles.length} slip away. ${pickCutoff()}`;
    }
    return `${persona.callsign} — nothing but crackle on the line this run. ${pickCutoff()}`;
}

// --- posting --------------------------------------------------------------------------------

async function getChannel() {
    if (channelCache) return channelCache;
    const id = config.kometaChannelId || config.broadcastChannelId || '';
    if (!id || !_client) return null;
    try {
        const ch = await _client.channels.fetch(id);
        if (ch && typeof ch.send === 'function') { channelCache = ch; return ch; }
    } catch (err) {
        logger.warn('Kometa Theater channel fetch failed:', err.message || err);
    }
    return null;
}

async function post(payload) {
    const ch = await getChannel();
    if (!ch) return;
    try {
        await ch.send(payload);
    } catch (err) {
        logger.warn('Kometa Theater post failed:', err.message || err);
    }
}

function buildReportEmbed(displayName, persona, text, hasChange) {
    return new EmbedBuilder()
        .setColor(hasChange ? 0x57F287 : 0x5865F2)
        .setAuthor({ name: `📻 ${persona.callsign || displayName}` })
        .setDescription(text)
        .setFooter({ text: displayName })
        .setTimestamp();
}

// --- session + paced worker -----------------------------------------------------------------

function beginSession() {
    if (sessionActive) return;
    sessionActive = true;
    ending = false;
    post({ content: '📡 **Incoming transmission…** Collections, report for duty.' });
}

async function endSession() {
    sessionActive = false;
    ending = false;
    changeBuffer.clear();
    pendingCounts = null;
    await post({ content: '📡 *…all units accounted for. Signing off until the next run.*' });
}

function enqueue(name, counts) {
    if (!sessionActive) beginSession();
    genQueue.push({
        name,
        norm: normalizeName(name),
        total: counts ? counts.total : null,
        added: counts ? counts.added : null,
        readyAt: Date.now() + GRACE_MS,
    });
}

// Turn a raw collection into a ready-to-post spec — this is where the Gemini time is spent.
async function renderSpec(item) {
    const isSeen = seenSet.has(item.norm);
    const wh = changeBuffer.get(item.norm) || null;
    changeBuffer.delete(item.norm);

    const addedTitles = wh ? wh.added : [];
    const removedTitles = wh ? wh.removed : [];
    const addedCount = addedTitles.length || item.added || 0;
    const created = wh ? wh.created : false;
    const hasChange = addedCount > 0 || removedTitles.length > 0 || created;
    // "Has content": holds items this run, or the webhook reported adds/creation, or we couldn't
    // read a count (null → assume content, so a real collection is never wrongly shown as static).
    const hasContent = item.total == null || item.total > 0 || hasChange;

    markSeen(item.norm); // either way, we've now met it

    if (classifyKind(isSeen, hasContent) === 'static') {
        return { kind: 'static', text: buildStaticText(item.name) };
    }

    // Comes alive: a brand-new unit with contents introduces itself; an established one reports in.
    const persona = await ensurePersona(item.name, item.norm);
    const ctx = { addedTitles, removedTitles, addedCount, created, hasChange, total: item.total };
    const text = await generateReport(persona, ctx, /* isNew */ !isSeen);
    return { kind: 'report', name: item.name, callsign: persona.callsign, text, hasChange };
}

function postSpec(spec) {
    if (spec.kind === 'static') return post({ content: spec.text });
    return post({ embeds: [buildReportEmbed(spec.name, { callsign: spec.callsign }, spec.text, spec.hasChange)] });
}

// PRODUCER: generate specs continuously, back-to-back, as soon as collections are ready. Each
// prompt gets full time to generate (paced only by Gemini's own latency), and finished messages
// pile up in the persisted post queue ahead of the poster.
async function produce() {
    produceTimer = null;
    let nextDelay = IDLE_MS;
    try {
        if (genQueue.length && genQueue[0].readyAt <= Date.now()) {
            const item = genQueue.shift();
            generating = true;
            try {
                postQueue.push(await renderSpec(item));
                savePostQueue();
            } finally {
                generating = false;
            }
            nextDelay = 0; // no artificial pause — keep the queue filled ahead of the poster
        }
    } catch (err) {
        logger.error('Kometa Theater generate failed:', err.message || err);
        generating = false;
    }
    scheduleProduce(nextDelay);
}

// CONSUMER: post the pre-generated specs at the deliberate pace. Signs off once everything —
// the generation queue, an in-flight generation, and the post queue — is drained.
async function consume() {
    consumeTimer = null;
    let nextDelay = IDLE_MS;
    try {
        if (postQueue.length) {
            const spec = postQueue.shift();
            savePostQueue();
            await postSpec(spec);
            nextDelay = config.kometaTheaterDelayMs || 5000;
        } else if (sessionActive && ending && genQueue.length === 0 && !generating) {
            await endSession();
        }
    } catch (err) {
        logger.error('Kometa Theater post failed:', err.message || err);
    }
    scheduleConsume(nextDelay);
}

function scheduleProduce(ms) {
    if (produceTimer) clearTimeout(produceTimer);
    produceTimer = setTimeout(produce, ms);
}

function scheduleConsume(ms) {
    if (consumeTimer) clearTimeout(consumeTimer);
    consumeTimer = setTimeout(consume, ms);
}

// --- log tailer -----------------------------------------------------------------------------

function startTailer(filePath, onLine) {
    let offset = 0;
    let primed = false;
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let stopped = false;

    async function poll() {
        try {
            const stat = await fs.promises.stat(filePath);
            if (!primed) { offset = stat.size; primed = true; return; } // start at EOF — only new lines
            if (stat.size < offset) { offset = 0; pending = ''; } // rotated / truncated
            if (stat.size > offset) {
                const fh = await fs.promises.open(filePath, 'r');
                try {
                    const len = stat.size - offset;
                    const buf = Buffer.alloc(len);
                    await fh.read(buf, 0, len, offset);
                    offset = stat.size;
                    pending += decoder.write(buf);
                    let idx;
                    while ((idx = pending.indexOf('\n')) >= 0) {
                        const line = pending.slice(0, idx);
                        pending = pending.slice(idx + 1);
                        try { onLine(line); } catch (err) { logger.debug('Theater onLine error:', err.message || err); }
                    }
                } finally {
                    await fh.close();
                }
            }
        } catch (err) {
            if (err.code !== 'ENOENT') logger.debug('Kometa log tail error:', err.message || err);
        }
    }

    const timer = setInterval(() => { if (!stopped) poll(); }, 1000);
    poll();
    return () => { stopped = true; clearInterval(timer); };
}

function onLogLine(line) {
    const counts = parseProcessed(line);
    if (counts) { pendingCounts = counts; return; }
    if (/Finished\s+Collections\s+Run/.test(line)) { onRunEnd(); return; }
    const name = parseFinishedCollection(line);
    if (name) { enqueue(name, pendingCounts); pendingCounts = null; }
}

// --- feed hooks (called by helpers/broadcast.js when theater mode is on) ---------------------

function onRunStart() {
    beginSession();
}

function onRunEnd() {
    if (sessionActive) ending = true; // worker posts the closer once the queue drains
}

function onChanges(payload) {
    const p = payload || {};
    const name = p.collection || p.playlist;
    if (!name) return;
    changeBuffer.set(normalizeName(name), {
        added: (Array.isArray(p.additions) ? p.additions : []).map((a) => a && a.title).filter(Boolean),
        removed: (Array.isArray(p.removals) ? p.removals : []).map((a) => a && a.title).filter(Boolean),
        created: !!p.created,
        ts: Date.now(),
    });
}

function startKometaTheater(client) {
    if (!config.kometaTheaterEnabled) {
        logger.info('Kometa Theater disabled (kometaTheaterEnabled=false)');
        return;
    }
    _client = client;
    loadStore();
    postQueue = loadPostQueue(); // resume any messages queued up before a restart
    stopTailer = startTailer(config.kometaLogPath, onLogLine);
    scheduleProduce(IDLE_MS); // generator: fills the queue continuously
    scheduleConsume(IDLE_MS); // poster: drains the queue at the pace
    logger.info(`Kometa Theater enabled — narrating runs from ${config.kometaLogPath}`
        + (postQueue.length ? ` (resuming ${postQueue.length} queued transmissions)` : ''));
}

function isEnabled() {
    return !!config.kometaTheaterEnabled;
}

module.exports = {
    startKometaTheater,
    isEnabled,
    onRunStart,
    onRunEnd,
    onChanges,
    // exported for tests
    parseFinishedCollection,
    parseProcessed,
    normalizeName,
    classifyKind,
    buildStaticText,
};
