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
const TAIL_PATH = path.join(__dirname, '..', 'data', 'kometa_theater_tail.json');
const GRACE_MS = 3000;   // wait this long after a "Finished" line so its `changes` webhook can arrive
const IDLE_MS = 750;     // poll cadence when the queue is empty
const WATCHDOG_MS = 5 * 60 * 1000; // silent log + empty queues for this long = the run died
const MAX_SESSION_ERRORS = 5;

// --- pure helpers (exported for tests) -----------------------------------------------------

// The run's closing separator. Kometa words it "Finished Run" for a full run and
// "Finished Collections Run" / "Finished Playlists Run" for a narrowed one (kometa.py:480), so
// all three have to count — matching only the middle one left nothing able to end a session.
const RUN_END_RE = /Finished(?:\s+\w+)?\s+Run\b/;

// "…| Finished Nicolas Cage Collection |…" -> "Nicolas Cage". Ignores the run-end separator.
// Returns null when the line isn't a collection-finished line.
function parseFinishedCollection(line) {
    if (!line || RUN_END_RE.test(line)) return null;
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

// "…|          Movies Library          |…" -> "Movies". Kometa heads each library's section with
// a bare "<Name> Library" separator (kometa.py:644). Its other separators name a library too —
// "Applying Overlays for the Movies Library", "Skipping X Library" — so a line only counts when
// the name stands alone. Missing one costs a shared persona, never a crash.
function parseLibraryHeader(line) {
    if (!line || !/\[INFO\]/.test(line)) return null; // skips ERROR lines and traceback continuations
    const m = /\|\s+([^|]+?)\s+Library\s+\|/.exec(line);
    if (!m) return null;
    const name = m[1].trim();
    if (!name || name.length > 40 || name.includes(':')) return null;
    // "Mapping <Name> Library" (kometa.py:1129, new in 2.4.8) would otherwise be read as a
    // library called "Mapping <Name>" and mis-key every collection under it.
    if (/\s(?:for|from|in|of|to|under|this)\s|^(?:skipping|deleting|applying|mapping|removing|caching|no|overlay)\b/i.test(name)) return null;
    return name;
}

// Two libraries can hold collections of the same name — both of yours pull the same default
// files, so "IMDb Top 250" exists twice — and they are genuinely different collections. Keying
// the seen-set, the personas and the changes buffer by library as well is what stops the second
// library's pass from replaying the first library's cast under the same voices.
function collectionKey(library, name) {
    const norm = normalizeName(name);
    const lib = normalizeName(library || '').replace(/\s+library$/, '');
    return lib ? `${lib}::${norm}` : norm;
}

// "…| 3 Movies Missing |…" -> 3. Kometa reports this per collection (builder.py:4825/4897),
// between the "Processed" line and the "Finished" separator, and only when something IS missing.
function parseMissing(line) {
    const m = /(\d+)\s+(?:Movie|Show)s?\s+Missing\b/.exec(line || '');
    return m ? parseInt(m[1], 10) : null;
}

// How complete a collection is: what it holds against what its source list wanted. No missing
// line logged means nothing was missing, so `missing` of null counts as zero — but a null
// `present` (the collection never built, e.g. minimum not met) is genuinely unknown, and gets no
// mood rather than a wrong one.
function describeCompleteness(present, missing) {
    if (present == null) return null;
    const have = present;
    const wanted = have + (missing == null ? 0 : missing);
    if (wanted <= 0) return null;
    const ratio = have / wanted;
    const tier = ratio >= 0.99 ? 'complete'
        : ratio >= 0.75 ? 'nearly'
            : ratio >= 0.4 ? 'patchy'
                : 'threadbare';
    return { have, wanted, ratio, tier };
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

// The model likes to wrap its JSON in prose, or follow it with a second object once it has room
// to ramble. A greedy /\{[\s\S]*\}/ then spans from the first brace to the LAST one and
// JSON.parse throws, costing that collection its persona — so take the first balanced object.
function extractJsonObject(text) {
    const str = String(text || '');
    const start = str.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < str.length; i++) {
        const ch = str[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) return str.slice(start, i + 1);
    }
    return null;
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
let pendingMissing = null;      // last "N Movies Missing" seen, same attachment
let sessionActive = false;
let ending = false;
let produceTimer = null;
let consumeTimer = null;
let stopTailer = null;
let channelCache = null;
let sessionErrors = [];  // what Kometa reported wrong this run, folded into the sign-off
let lastLogActivity = 0; // last line the tailer saw — the run's pulse, for the watchdog
let currentLibrary = null; // library whose collections the log is currently walking
let tailOffset = 0;        // how far into the log we've read, mirrored into TAIL_PATH

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

// Where the tailer had reached, so a restart mid-run picks the log up where it left off instead
// of seeking to EOF and silently dropping every collection still to come. The post queue already
// survives a restart; without this the generation queue behind it did not.
function loadTail() {
    try {
        if (fs.existsSync(TAIL_PATH)) {
            const o = JSON.parse(fs.readFileSync(TAIL_PATH, 'utf8'));
            if (o && o.path === config.kometaLogPath && Number.isFinite(o.offset)) return o;
        }
    } catch (err) {
        logger.warn('Kometa Theater tail load failed:', err.message || err);
    }
    return null;
}

function saveTail() {
    try {
        fs.mkdirSync(path.dirname(TAIL_PATH), { recursive: true });
        fs.writeFileSync(TAIL_PATH, JSON.stringify({
            path: config.kometaLogPath, offset: tailOffset, session: sessionActive,
        }));
    } catch (err) {
        logger.debug('Kometa Theater tail save failed:', err.message || err);
    }
}

// --- Gemini (fast model, graceful fallback) -------------------------------------------------

function theaterModel() {
    if (!_model) {
        _model = getModel({
            model: config.kometaTheaterModel || undefined, // blank → geminiAPI DEFAULT_MODEL
            // Moderate temperature keeps voices coherent (high temp was producing nonsense). The
            // token budget has to cover the model's own reasoning as well as the line it finally
            // writes: at 1000 nearly six in ten replies died on MAX_TOKENS mid-sentence.
            generationConfig: { temperature: 0.9, maxOutputTokens: 3000 },
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
        const raw = extractJsonObject(res.response.text());
        if (raw) {
            const o = JSON.parse(raw);
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

// How a collection feels about itself, by how much of it is actually there. This is the whole
// point of reading the missing counts: a complete collection should sound smug and a threadbare
// one should sound furious, rather than every unit having the same even temper.
const MOODS = {
    complete: 'Your collection is COMPLETE — every title it is meant to hold is present. You are delighted about this, triumphant, possibly insufferable about it.',
    nearly: 'Your collection is very nearly complete. You are pleased on the whole, though the handful of stragglers nag at you.',
    patchy: 'Your collection has real, visible gaps. You are irritable about it and pointed about what is still missing.',
    threadbare: 'Your collection is mostly MISSING — far more absent than present. You are ANGRY: aggrieved, indignant, and in no mood to hide it from the server.',
};

async function generateReport(persona, ctx, isNew) {
    let context;
    if (ctx.hasChange) {
        const addStr = ctx.addedTitles.length ? titleList(ctx.addedTitles, 'none') : (ctx.addedCount ? `${ctx.addedCount} new` : 'none');
        const remStr = ctx.removedTitles.length ? titleList(ctx.removedTitles, 'none') : 'none';
        context = `This run, these titles were added to you: ${addStr}. Removed: ${remStr}.${ctx.created ? ' You were just created this run.' : ''} React in character to these specific changes.`;
    } else {
        context = `Nothing was added or removed from you this run${ctx.total ? ` — you currently hold ${ctx.total} titles` : ''}. React however your character would to a quiet, uneventful check-in.`;
    }
    let mood = '';
    if (ctx.completeness) {
        const c = ctx.completeness;
        mood = `${MOODS[c.tier]} (You hold ${c.have} of the ${c.wanted} titles you should — ${Math.round(c.ratio * 100)}%.) `
            + `Let that feeling drive the whole reply; you may reference how full or empty you are, but stay in character.\n`;
    }
    const intro = isNew ? 'This is the first time the server has met you — introduce yourself in your own unmistakable style. ' : '';
    try {
        const prompt = `You ARE this character. Name/handle: "${persona.callsign}". Persona: ${persona.vibe}\n`
            + `You are the voice of a Plex media collection. The server just checked on you during a library update.\n`
            + `${intro}${context}\n${mood}`
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
    sessionErrors = [];
    lastLogActivity = Date.now();
    currentLibrary = null;
    saveTail();
    post({ content: '📡 **Incoming transmission…** Collections, report for duty.' });
}

// `lost` = Kometa stopped writing to its log without ever sending run_end, so the run died or
// was killed mid-roll-call. Closing either way matters: while sessionActive stays true the
// beginSession() guard swallows the NEXT run's opener too.
async function endSession(lost = false) {
    sessionActive = false;
    ending = false;
    changeBuffer.clear();
    pendingCounts = null;
    currentLibrary = null;
    saveTail();
    const errors = sessionErrors.slice();
    sessionErrors = [];
    const closer = lost
        ? '📡 *…the roll-call cuts out mid-sentence. Nothing further came down the line.*'
        : '📡 *…all units accounted for. Signing off until the next run.*';
    if (!errors.length) {
        await post({ content: closer });
        return;
    }
    await post({
        content: closer,
        embeds: [new EmbedBuilder()
            .setColor(lost ? 0xED4245 : 0xFEE75C)
            .setAuthor({ name: '📻 interference on the line' })
            .setDescription(errors.map((e) => `• ${e}`).join('\n').slice(0, 4000))
            .setTimestamp()],
    });
}

function enqueue(name, counts, missing) {
    if (!sessionActive) beginSession();
    genQueue.push({
        name,
        library: currentLibrary,
        key: collectionKey(currentLibrary, name),
        total: counts ? counts.total : null,
        missing,
        added: counts ? counts.added : null,
        readyAt: Date.now() + GRACE_MS,
    });
}

// Turn a raw collection into a ready-to-post spec — this is where the Gemini time is spent.
async function renderSpec(item) {
    const isSeen = seenSet.has(item.key);
    const wh = changeBuffer.get(item.key) || null;
    changeBuffer.delete(item.key);

    const addedTitles = wh ? wh.added : [];
    const removedTitles = wh ? wh.removed : [];
    const addedCount = addedTitles.length || item.added || 0;
    const created = wh ? wh.created : false;
    const hasChange = addedCount > 0 || removedTitles.length > 0 || created;
    // "Has content": holds items this run, or the webhook reported adds/creation, or we couldn't
    // read a count (null → assume content, so a real collection is never wrongly shown as static).
    const hasContent = item.total == null || item.total > 0 || hasChange;

    markSeen(item.key); // either way, we've now met it

    if (classifyKind(isSeen, hasContent) === 'static') {
        return { kind: 'static', text: buildStaticText(item.name) };
    }

    // Comes alive: a brand-new unit with contents introduces itself; an established one reports in.
    const persona = await ensurePersona(item.name, item.key);
    const ctx = {
        addedTitles, removedTitles, addedCount, created, hasChange, total: item.total,
        completeness: describeCompleteness(item.total, item.missing),
    };
    const text = await generateReport(persona, ctx, /* isNew */ !isSeen);
    // The footer carries the library so the same collection name coming round again on the next
    // library reads as a different unit rather than the roll call starting over.
    const label = item.library ? `${item.name} · ${item.library}` : item.name;
    return { kind: 'report', name: label, callsign: persona.callsign, text, hasChange };
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
        } else if (sessionActive && genQueue.length === 0 && !generating) {
            if (ending) await endSession();
            else if (Date.now() - lastLogActivity > WATCHDOG_MS) await endSession(true);
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

function startTailer(filePath, onLine, resumeFrom) {
    let offset = Number.isFinite(resumeFrom) ? resumeFrom : 0;
    let primed = Number.isFinite(resumeFrom);
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
                    tailOffset = offset;
                    saveTail();
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
    lastLogActivity = Date.now();
    const counts = parseProcessed(line);
    if (counts) { pendingCounts = counts; return; }
    const library = parseLibraryHeader(line);
    if (library) { currentLibrary = library; pendingCounts = null; pendingMissing = null; return; }
    const missing = parseMissing(line);
    if (missing != null) { pendingMissing = missing; return; }
    if (RUN_END_RE.test(line)) { onRunEnd(); return; }
    const name = parseFinishedCollection(line);
    if (name) { enqueue(name, pendingCounts, pendingMissing); pendingCounts = null; pendingMissing = null; }
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
    changeBuffer.set(collectionKey(p.library_name, name), {
        added: (Array.isArray(p.additions) ? p.additions : []).map((a) => a && a.title).filter(Boolean),
        removed: (Array.isArray(p.removals) ? p.removals : []).map((a) => a && a.title).filter(Boolean),
        created: !!p.created,
        ts: Date.now(),
    });
}

// Kometa fires `error` once per saved error and once per config warning, so posting them as
// they land would spam the channel on every run — which is why they used to be dropped outright.
// Collecting them for the sign-off keeps the channel quiet AND makes a run that dies partway
// visible, instead of an opener followed by permanent silence.
function onError(payload) {
    const text = String((payload || {}).error || '').trim().replace(/\s+/g, ' ').slice(0, 300);
    if (!text || !sessionActive) return;
    if (sessionErrors.length >= MAX_SESSION_ERRORS || sessionErrors.includes(text)) return;
    sessionErrors.push(text);
}

function startKometaTheater(client) {
    if (!config.kometaTheaterEnabled) {
        logger.info('Kometa Theater disabled (kometaTheaterEnabled=false)');
        return;
    }
    _client = client;
    loadStore();
    postQueue = loadPostQueue(); // resume any messages queued up before a restart
    const tail = loadTail();
    let resumeFrom;
    if (tail) {
        // A log smaller than the saved offset rotated while we were down: read the new one whole.
        let size = null;
        try { size = fs.statSync(config.kometaLogPath).size; } catch (_) { /* gone; prime at EOF */ }
        if (size != null) resumeFrom = size < tail.offset ? 0 : tail.offset;
        // Carry the open session across so the roll call continues rather than re-announcing.
        if (resumeFrom != null) tailOffset = resumeFrom;
        if (resumeFrom != null && tail.session) { sessionActive = true; lastLogActivity = Date.now(); }
    }
    stopTailer = startTailer(config.kometaLogPath, onLogLine, resumeFrom);
    scheduleProduce(IDLE_MS); // generator: fills the queue continuously
    scheduleConsume(IDLE_MS); // poster: drains the queue at the pace
    logger.info(`Kometa Theater enabled — narrating runs from ${config.kometaLogPath}`
        + (resumeFrom != null ? ` (resuming at byte ${resumeFrom}${sessionActive ? ', session still open' : ''})` : '')
        + (postQueue.length ? ` (${postQueue.length} queued transmissions)` : ''));
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
    onError,
    // exported for tests
    parseFinishedCollection,
    parseProcessed,
    parseMissing,
    describeCompleteness,
    parseLibraryHeader,
    collectionKey,
    normalizeName,
    classifyKind,
    buildStaticText,
    extractJsonObject,
};
