// helpers/gamePresence.js after !restart.
//
// The bug: each startGamePresence kept its own record of what the owner was playing, starting
// empty. On the new client after !restart, the first presence update for a game already open, such
// as a change of its details line, announced it as just started.
//
// Harness: fake clients (EventEmitters emitting 'presenceUpdate' the way discord.js does, with the
// cached old presence first) and broadcast.js swapped in require.cache to record announcements.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ActivityType } = require('discord.js');

const announced = [];
const broadcastFile = require.resolve(path.join(__dirname, '..', 'helpers', 'broadcast.js'));
require.cache[broadcastFile] = {
	id: broadcastFile, filename: broadcastFile, loaded: true,
	exports: { broadcastGamePresence: async (client, info) => { announced.push({ client, game: info.game }); } }
};

const config = require('../config/config.js');
const gamePresence = require('../helpers/gamePresence.js');

let saved;
test.beforeEach(() => {
	announced.length = 0;
	gamePresence._reset();
	saved = { gamePresenceEnabled: config.gamePresenceEnabled, ownerId: config.ownerId };
	Object.assign(config, { gamePresenceEnabled: true, ownerId: 'owner' });
});
test.afterEach(() => Object.assign(config, saved));

function presence(...games) {
	return {
		userId: 'owner',
		user: { username: 'zack' },
		activities: games.map(([name, details]) => ({ type: ActivityType.Playing, name, details }))
	};
}

function games() {
	return announced.map((a) => a.game);
}

test('after !restart a game already running is not announced again', () => {
	const oldClient = new EventEmitter();
	gamePresence.startGamePresence(oldClient);
	oldClient.emit('presenceUpdate', presence(), presence(['Hades', 'Tartarus']));
	assert.deepStrictEqual(games(), ['Hades']);

	const newClient = new EventEmitter();
	gamePresence.startGamePresence(newClient);
	newClient.emit('presenceUpdate', presence(['Hades', 'Tartarus']), presence(['Hades', 'Asphodel']));
	assert.deepStrictEqual(games(), ['Hades'], 'only a details change');

	newClient.emit('presenceUpdate', presence(['Hades', 'Asphodel']), presence(['Hades', 'Asphodel'], ['Celeste']));
	assert.deepStrictEqual(games(), ['Hades', 'Celeste']);
	assert.strictEqual(announced[1].client, newClient);
});

test('a game launched while the bot was between clients is announced by the new one', () => {
	const oldClient = new EventEmitter();
	gamePresence.startGamePresence(oldClient);
	oldClient.emit('presenceUpdate', presence(), presence(['Hades']));

	// The new client's cache already holds Celeste: it started during the restart.
	const newClient = new EventEmitter();
	gamePresence.startGamePresence(newClient);
	newClient.emit('presenceUpdate', presence(['Hades'], ['Celeste', 'Prologue']), presence(['Hades'], ['Celeste', 'Chapter 1']));
	assert.deepStrictEqual(games(), ['Hades', 'Celeste']);
	assert.strictEqual(announced[1].client, newClient);
});

test('after a cold boot a game already running is announced once, as before', () => {
	const client = new EventEmitter();
	gamePresence.startGamePresence(client);
	client.emit('presenceUpdate', presence(['Hades', 'Tartarus']), presence(['Hades', 'Asphodel']));
	client.emit('presenceUpdate', presence(['Hades', 'Asphodel']), presence(['Hades', 'Elysium']));
	assert.deepStrictEqual(games(), ['Hades']);
});
