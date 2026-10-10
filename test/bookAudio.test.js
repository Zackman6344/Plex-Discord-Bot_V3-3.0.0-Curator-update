// helpers/bookAudio.js: the ffmpeg command line and environment for audiobook playback.
//
// The bug: with `-ss` after `-i` ffmpeg decodes and discards from 0:00, so resuming five hours
// into an m4b takes minutes; a `-headers` or token query on the command line exposes the Plex
// token to anything that lists processes; and an inherited `http_proxy` sends even 127.0.0.1
// through the proxy, so the part never loads.
//
// Pure argument checks in the style of test/seek.test.js.

const test = require('node:test');
const assert = require('node:assert');

const { bookArgs, ffmpegEnv } = require('../helpers/bookAudio.js');
const { seekArgs } = require('../helpers/seek.js');

const URL = 'http://127.0.0.1:40000/0123456789abcdef0123456789abcdef/library/parts/101/1700000000/file.m4b';

test('-ss goes before -i, in seconds with millisecond precision', () => {
	const args = bookArgs({ url: URL, startMs: 18000123, speed: 1 });
	const ss = args.indexOf('-ss');
	assert.notStrictEqual(ss, -1);
	assert.strictEqual(args[ss + 1], '18000.123');
	assert.ok(ss < args.indexOf('-i'));
	assert.strictEqual(args[args.indexOf('-i') + 1], URL);
});

test('there is no -ss at offset 0', () => {
	assert.ok(!bookArgs({ url: URL, startMs: 0, speed: 1 }).includes('-ss'));
});

test('atempo is added only off 1x', () => {
	assert.ok(!bookArgs({ url: URL, startMs: 0, speed: 1 }).includes('-af'));
	const args = bookArgs({ url: URL, startMs: 0, speed: 1.5 });
	assert.strictEqual(args[args.indexOf('-af') + 1], 'atempo=1.5');
});

test('reconnect flags come before the input', () => {
	const args = bookArgs({ url: URL, startMs: 5000, speed: 2 });
	const input = args.indexOf('-i');
	for (const flag of ['-reconnect', '-reconnect_on_network_error', '-reconnect_delay_max']) {
		const at = args.indexOf(flag);
		assert.ok(at !== -1 && at < input, flag);
	}
	assert.strictEqual(args[args.indexOf('-reconnect_delay_max') + 1], '5');
});

test('the command line carries no token, -headers or -usetoc', () => {
	const args = bookArgs({ url: URL, startMs: 1000, speed: 1.25 });
	const line = args.join(' ');
	assert.ok(!/token/i.test(line));
	assert.ok(!args.includes('-headers'));
	assert.ok(!args.includes('-usetoc'));
});

test('the output tail matches music\'s seek encoder and writes to stdout', () => {
	const args = bookArgs({ url: URL, startMs: 1000, speed: 1 });
	assert.strictEqual(args[args.length - 1], 'pipe:1');
	const tail = seekArgs(1000).slice(-8);
	assert.deepStrictEqual(args.slice(-9, -1), tail);
	assert.deepStrictEqual(tail, ['-acodec', 'libopus', '-f', 'opus', '-ar', '48000', '-ac', '2']);
});

test('ffmpegEnv drops every proxy variable whatever its case and keeps the rest', () => {
	const env = {
		http_proxy: 'http://proxy:1', HTTP_PROXY: 'http://proxy:2',
		https_proxy: 'http://proxy:3', HTTPS_PROXY: 'http://proxy:4',
		all_proxy: 'socks5://proxy:5', ALL_PROXY: 'socks5://proxy:6',
		Http_Proxy: 'http://proxy:7',
		PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', NO_PROXY: 'localhost'
	};
	assert.deepStrictEqual(ffmpegEnv(env), { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', NO_PROXY: 'localhost' });
});

test('ffmpegEnv leaves its input untouched', () => {
	const env = { http_proxy: 'http://proxy:1', PATH: '/usr/bin' };
	ffmpegEnv(env);
	assert.deepStrictEqual(env, { http_proxy: 'http://proxy:1', PATH: '/usr/bin' });
});
