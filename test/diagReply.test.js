// commands/test.js: the !diag reply.
//
// Since the Plex Media world, the health report can quote a player's slot name or a room's own
// words, so the reply must ping nobody and must fit Discord's 2,000 characters, which it refuses
// whole rather than cuts.
//
// Harness: helpers/healthCheck.js replaced in require.cache, so the report is whatever a test sets.

const test = require('node:test');
const assert = require('node:assert');

const healthPath = require.resolve('../helpers/healthCheck.js');
let report = '';
require.cache[healthPath] = {
	id: healthPath,
	filename: healthPath,
	loaded: true,
	exports: { runHealthCheck: async () => ({}), formatHealthCheck: () => report },
};
const diag = require('../commands/test.js');

async function reply() {
	const sent = [];
	await diag.command.process(null, null, { reply: async (payload) => { sent.push(payload); } });
	assert.strictEqual(sent.length, 1);
	return sent[0];
}

test('!diag pings nobody, whatever the report quotes', async () => {
	report = '  \u2717 ApMedia: 1 slot lost its watch (@everyone <@&300000000000000003>)';
	const payload = await reply();
	assert.deepStrictEqual(payload.allowedMentions, { parse: [] });
	assert.ok(payload.content.includes(report), payload.content);
});

test('a report too long for one message is cut to fit, inside its code block', async () => {
	report = '\u2713 Plex: ok\n'.repeat(400);
	const payload = await reply();
	assert.ok(payload.content.length <= 2000, String(payload.content.length));
	assert.ok(payload.content.endsWith('\u2026\n```'), payload.content.slice(-20));
	assert.strictEqual(payload.content.split('```').length - 1, 2);

	report = 'short';
	assert.ok((await reply()).content.endsWith('\nshort\n```'));
});
