// helpers/apworldBuild.js
// Packs apworld/plex_media into plex_media.apworld, the file the owner installs into Archipelago.
//
// Two defects in an .apworld break every Archipelago process on the PC that loads worlds (the
// Launcher, Generate, the room server, the bot's !ap next worker): a file that is not a valid zip,
// and a manifest whose game loads but whose world_version, minimum_ap_version or maximum_ap_version
// is not exactly x.y.z (AP 0.6.8 parses it a second time outside any try). So the manifest is
// checked before a byte is written, the zip is written by hand with nothing for a reader to disagree
// about (stored entries, no extra fields, UTF-8 names, every timestamp 1980-01-01 so one source tree
// always gives the same bytes), and writeApworld lands the file with a rename.
//
// Text files go in with LF line endings whatever the checkout uses (core.autocrlf makes them CRLF on
// Windows), so a Windows checkout and the Docker image build the same apworld.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { GAME, APWORLD_NAME } = require('./apMediaContracts.js');

const DEFAULT_SRC = path.join(__dirname, '..', 'apworld', APWORLD_NAME);
const MANIFEST = 'archipelago.json';
const COMPATIBLE_VERSION = 7;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SKIPPED_DIRS = new Set(['__pycache__', 'tests']);
const TEXT_EXTENSIONS = new Set(['.py', '.json', '.md', '.txt', '.yaml', '.yml']);
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const UTF8_NAMES = 0x0800;
const STORED = 0;

let CRC_TABLE = null;
function crc32Fallback(buf) {
	if (!CRC_TABLE) {
		CRC_TABLE = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			CRC_TABLE[n] = c >>> 0;
		}
	}
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

// zlib.crc32 arrived in Node 20.15 / 22.2, and package.json still allows Node 18.
function crc32(buf) {
	if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
	return crc32Fallback(buf);
}

function toLf(buf) {
	if (!buf.includes(13)) return buf;
	const out = Buffer.alloc(buf.length);
	let n = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === 13 && buf[i + 1] === 10) continue;
		out[n++] = buf[i];
	}
	return out.subarray(0, n);
}

function collectFiles(srcDir) {
	const files = [];
	const walk = (dir, rel) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith('.')) continue;
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRS.has(entry.name)) walk(full, relPath);
			} else if (entry.isFile() && !entry.name.endsWith('.pyc')) {
				files.push({ rel: relPath, full });
			}
		}
	};
	walk(srcDir, '');
	return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function versionProblem(manifest, key) {
	const value = manifest[key];
	if (typeof value === 'string' && VERSION_RE.test(value)) return null;
	return `${MANIFEST} ${key} must be exactly x.y.z (three whole numbers), not ${JSON.stringify(value)}`;
}

/** The manifest as AP would read it, or an Error naming what would break Archipelago. */
function checkManifest(raw, worldVersion) {
	let manifest;
	try {
		manifest = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
	} catch (err) {
		throw new Error(`${MANIFEST} is not valid JSON: ${err.message}`);
	}
	if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
		throw new Error(`${MANIFEST} must hold a JSON object`);
	}
	if (manifest.game !== GAME) {
		throw new Error(`${MANIFEST} game must be ${JSON.stringify(GAME)}, not ${JSON.stringify(manifest.game)}`);
	}
	if (manifest.compatible_version !== COMPATIBLE_VERSION) {
		throw new Error(`${MANIFEST} compatible_version must be ${COMPATIBLE_VERSION}, not ${JSON.stringify(manifest.compatible_version)}`);
	}
	if (worldVersion != null) manifest = { ...manifest, world_version: worldVersion };
	const problem = versionProblem(manifest, 'world_version')
		|| ['minimum_ap_version', 'maximum_ap_version']
			.filter((key) => key in manifest)
			.map((key) => versionProblem(manifest, key))
			.find(Boolean);
	if (problem) throw new Error(problem);
	return manifest;
}

function zipStore(entries) {
	if (entries.length > 0xffff) throw new Error(`too many files for a plain zip: ${entries.length}`);
	const parts = [];
	const central = [];
	let offset = 0;
	for (const { name, data, crc } of entries) {
		const nameBuf = Buffer.from(name, 'utf8');
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(10, 4);
		local.writeUInt16LE(UTF8_NAMES, 6);
		local.writeUInt16LE(STORED, 8);
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		parts.push(local, nameBuf, data);

		const header = Buffer.alloc(46);
		header.writeUInt32LE(0x02014b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(10, 6);
		header.writeUInt16LE(UTF8_NAMES, 8);
		header.writeUInt16LE(STORED, 10);
		header.writeUInt16LE(DOS_TIME, 12);
		header.writeUInt16LE(DOS_DATE, 14);
		header.writeUInt32LE(crc, 16);
		header.writeUInt32LE(data.length, 20);
		header.writeUInt32LE(data.length, 24);
		header.writeUInt16LE(nameBuf.length, 28);
		header.writeUInt32LE(offset, 42);
		central.push(header, nameBuf);
		offset += local.length + nameBuf.length + data.length;
	}
	const directory = Buffer.concat(central);
	if (offset + directory.length > 0xffffffff) throw new Error('the apworld is too large for a plain zip');
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, directory, end]);
}

/**
 * Builds the apworld in memory.
 * @param {{srcDir?: string, worldVersion?: string}} [options]  worldVersion replaces the manifest's
 * @returns {{buffer: Buffer, bytes: number, worldVersion: string, files: string[], entries: {name: string, crc: number, size: number}[]}}  files: zip member names
 */
function buildApworld({ srcDir = DEFAULT_SRC, worldVersion } = {}) {
	const root = path.resolve(srcDir);
	const found = collectFiles(root);
	const manifestFile = found.find((file) => file.rel === MANIFEST);
	if (!manifestFile) throw new Error(`${path.join(root, MANIFEST)} is missing`);
	if (!found.some((file) => file.rel === '__init__.py')) throw new Error(`${path.join(root, '__init__.py')} is missing`);
	const manifestRaw = toLf(fs.readFileSync(manifestFile.full));
	const manifest = checkManifest(manifestRaw, worldVersion);
	const entries = found.map((file) => {
		let data;
		if (file === manifestFile) {
			data = worldVersion == null ? manifestRaw : Buffer.from(`${JSON.stringify(manifest, null, '\t')}\n`, 'utf8');
		} else {
			data = fs.readFileSync(file.full);
			if (TEXT_EXTENSIONS.has(path.extname(file.rel).toLowerCase())) data = toLf(data);
		}
		return { name: `${APWORLD_NAME}/${file.rel}`, data, crc: crc32(data) };
	});
	const buffer = zipStore(entries);
	return {
		buffer,
		bytes: buffer.length,
		worldVersion: manifest.world_version,
		files: entries.map((e) => e.name),
		entries: entries.map((e) => ({ name: e.name, crc: e.crc, size: e.data.length })),
	};
}

/** Builds the apworld and writes it to outFile through <outFile>.tmp and a rename. */
function writeApworld(outFile, options = {}) {
	const built = buildApworld(options);
	const target = path.resolve(outFile);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, built.buffer);
	try {
		fs.renameSync(tmp, target);
	} catch (err) {
		try { fs.unlinkSync(tmp); } catch { /* the rename's error is the one to report */ }
		throw err;
	}
	return { ...built, file: target };
}

/**
 * The manifest inside an installed .apworld (stored or deflated), read without writing anything,
 * or null when the zip holds none. Throws when the file is not a zip.
 */
function readApworldManifest(file) {
	const buf = fs.readFileSync(file);
	const entry = readZipDirectory(buf, file).find((e) => e.name.endsWith(MANIFEST));
	if (!entry) return null;
	return JSON.parse(readZipMember(buf, entry, file).toString('utf8'));
}

/**
 * The central directory of a zip held in memory. Throws when it is not a zip or the directory is
 * cut short; `label` names the file in those errors.
 * @returns {{name: string, method: number, crc: number, size: number, compressedSize: number, localOffset: number}[]}
 */
function readZipDirectory(buf, label = 'the data') {
	const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (endAt < 0 || endAt + 22 > buf.length) throw new Error(`${label} is not a zip`);
	const count = buf.readUInt16LE(endAt + 10);
	let at = buf.readUInt32LE(endAt + 16);
	const entries = [];
	for (let i = 0; i < count; i++) {
		if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`${label} has a broken zip directory`);
		const nameLen = buf.readUInt16LE(at + 28);
		entries.push({
			name: buf.toString('utf8', at + 46, at + 46 + nameLen),
			method: buf.readUInt16LE(at + 10),
			crc: buf.readUInt32LE(at + 16),
			compressedSize: buf.readUInt32LE(at + 20),
			size: buf.readUInt32LE(at + 24),
			localOffset: buf.readUInt32LE(at + 42),
		});
		at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
	}
	return entries;
}

function readZipMember(buf, entry, label) {
	const local = entry.localOffset;
	if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${label} has a broken zip entry`);
	const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
	const raw = buf.subarray(start, start + entry.compressedSize);
	const data = entry.method === STORED ? raw : entry.method === 8 ? zlib.inflateRawSync(raw) : null;
	if (!data) throw new Error(`${label} stores ${entry.name} with zip method ${entry.method}`);
	return data;
}

function builtMember(name) {
	if (name.endsWith('/') || name.endsWith('.pyc')) return false;
	const parts = name.split('/');
	if (parts.some((part) => part.startsWith('.'))) return false;
	return !parts.slice(0, -1).some((part) => SKIPPED_DIRS.has(part));
}

/**
 * The installed .apworld at `file` against a buildApworld() result, member by member.
 * @returns {{state: 'same'|'differs'|'version'|'missing'|'unreadable'|'notzip'|'nomanifest', version: string|null, differ: string[], code: string|null}}
 */
function compareInstalled(file, built) {
	const answer = (state, extra = {}) => ({ state, version: null, differ: [], code: null, ...extra });
	let buf;
	try {
		buf = fs.readFileSync(file);
	} catch (err) {
		if (err && err.code === 'ENOENT') return answer('missing');
		if (err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EBUSY')) return answer('unreadable', { code: err.code });
		throw err;
	}
	if (buf.equals(built.buffer)) return answer('same', { version: built.worldVersion });
	let directory;
	let manifest;
	try {
		directory = readZipDirectory(buf, file);
		const entry = directory.find((e) => e.name.endsWith(MANIFEST));
		manifest = entry ? JSON.parse(readZipMember(buf, entry, file).toString('utf8')) : null;
	} catch (err) {
		return answer('notzip');
	}
	if (!manifest || typeof manifest !== 'object') return answer('nomanifest');
	const version = typeof manifest.world_version === 'string' ? manifest.world_version : null;
	if (version !== built.worldVersion) return answer('version', { version });
	const prefix = `${APWORLD_NAME}/`;
	const short = (name) => (name.startsWith(prefix) ? name.slice(prefix.length) : name);
	const want = new Map(built.entries.map((e) => [e.name, e]));
	const differ = new Set();
	const seen = new Set();
	for (const entry of directory) {
		if (!builtMember(entry.name)) continue;
		seen.add(entry.name);
		const mine = want.get(entry.name);
		if (!mine || mine.crc !== entry.crc || mine.size !== entry.size) differ.add(short(entry.name));
	}
	for (const name of want.keys()) if (!seen.has(name)) differ.add(short(name));
	if (differ.size === 0) return answer('same', { version });
	return answer('differs', { version, differ: [...differ].sort() });
}

/** Where Archipelago keeps this world under its install folder, or null for a blank folder. */
function installedApworldPath(dir) {
	if (typeof dir !== 'string' || !dir.trim()) return null;
	return path.join(dir.trim(), 'custom_worlds', `${APWORLD_NAME}.apworld`);
}

let cachedBuild = null;
const installedCache = new Map();

/**
 * compareInstalled for the copy under `dir` against this checkout's build, cached by the file's
 * size and mtime unless `fresh`. Never throws: an error reads as unreadable.
 */
function checkInstalled(dir, { fresh = false } = {}) {
	const file = installedApworldPath(dir);
	if (!file) return { state: 'missing', version: null, differ: [], code: null };
	try {
		let key = null;
		try {
			const stat = fs.statSync(file);
			key = `${file}|${stat.size}|${stat.mtimeMs}`;
		} catch (err) {
			if (!err || err.code !== 'ENOENT') throw err;
		}
		if (!fresh && key && installedCache.has(key)) return installedCache.get(key);
		if (!cachedBuild) cachedBuild = buildApworld();
		const result = compareInstalled(file, cachedBuild);
		installedCache.clear();
		if (key) installedCache.set(key, result);
		return result;
	} catch (err) {
		return { state: 'unreadable', version: null, differ: [], code: (err && err.code) || null };
	}
}

function resetInstalledCache() {
	cachedBuild = null;
	installedCache.clear();
}

module.exports = {
	buildApworld,
	writeApworld,
	readApworldManifest,
	readZipDirectory,
	compareInstalled,
	installedApworldPath,
	checkInstalled,
	checkManifest,
	crc32,
	DEFAULT_SRC,
	_internal: { crc32Fallback, toLf, zipStore, collectFiles, resetInstalledCache },
};
