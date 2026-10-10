// scripts/validate-slash.js: the pre-registration checks behind `npm run check:slash`.
//
// The bug: Discord rejects the whole registration payload for one bad choice or one oversized
// command, and every /command disappears at once. A numeric speed choice on a STRING option, a
// string on an INTEGER option, a NaN on a NUMBER option, a 101-character choice name or a command
// over 4000 characters all passed the old checks, which looked only at a choice's presence.
//
// Harness: validate() fed hand-made command maps through the real slashRegistry.buildSpec, one
// bad case each, plus the real command tree.

const test = require('node:test');
const assert = require('node:assert');

const { validate, commandChars, COMMAND_CHAR_BUDGET } = require('../scripts/validate-slash.js');

function cmd(options, extra = {}) {
	return { slash: Object.assign({ description: 'A test command', options }, extra), process() {} };
}

function problemsFor(command) {
	return validate({ zztest: command }).problems;
}

test('a well-formed command passes', () => {
	const good = cmd([
		{ name: 'rate', type: 'STRING', description: 'Speed', choices: [{ name: '1.25x', value: '1.25' }] },
		{ name: 'seconds', type: 'INTEGER', description: 'How far', choices: [{ name: '30 s', value: 30 }] },
		{ name: 'factor', type: 'NUMBER', description: 'Factor', choices: [{ name: 'half', value: 0.5 }] }
	]);
	assert.deepStrictEqual(problemsFor(good), []);
});

test('a number on a STRING option fails', () => {
	const p = problemsFor(cmd([{ name: 'rate', type: 'STRING', description: 'Speed', choices: [{ name: '1.25x', value: 1.25 }] }]));
	assert.strictEqual(p.length, 1);
	assert.match(p[0], /needs a string value of 1-100 chars on a STRING option/);
});

test('an empty or 101-character string value fails', () => {
	for (const value of ['', 'v'.repeat(101)]) {
		const p = problemsFor(cmd([{ name: 'x', type: 'STRING', description: 'X', choices: [{ name: 'x', value }] }]));
		assert.strictEqual(p.length, 1, JSON.stringify(value).slice(0, 20));
	}
});

test('a string or a fraction on an INTEGER option fails', () => {
	for (const value of ['30', 2.5]) {
		const p = problemsFor(cmd([{ name: 'seconds', type: 'INTEGER', description: 'How far', choices: [{ name: 'x', value }] }]));
		assert.strictEqual(p.length, 1, String(value));
		assert.match(p[0], /needs an integer value on an INTEGER option/);
	}
});

test('a non-finite NUMBER fails', () => {
	for (const value of [NaN, Infinity, '0.5']) {
		const p = problemsFor(cmd([{ name: 'factor', type: 'NUMBER', description: 'Factor', choices: [{ name: 'x', value }] }]));
		assert.strictEqual(p.length, 1, String(value));
		assert.match(p[0], /needs a finite number on a NUMBER option/);
	}
});

test('a 101-character choice name fails, 100 passes', () => {
	const at = n => problemsFor(cmd([{ name: 'x', type: 'STRING', description: 'X', choices: [{ name: 'n'.repeat(n), value: 'v' }] }]));
	assert.deepStrictEqual(at(100), []);
	assert.strictEqual(at(101).length, 1);
	assert.match(at(101)[0], /choice name .* is 101 chars/);
});

test('choices on an option type that cannot have them fail', () => {
	const p = problemsFor(cmd([{ name: 'flag', type: 'BOOLEAN', description: 'Flag', choices: [{ name: 'yes', value: true }] }]));
	assert.ok(p.some(x => /choices only work on STRING, INTEGER and NUMBER/.test(x)));
});

test('a command over 4000 characters fails, and exactly 4000 passes', () => {
	// name 'zztest' (6) + description, then each subcommand's name and description.
	const sub = (i, len) => ({ name: `s${i}`, description: 'd'.repeat(len) });
	const build = (extra) => {
		const subs = [];
		let used = 'zztest'.length + 'A test command'.length;
		let i = 0;
		while (COMMAND_CHAR_BUDGET + extra - used > 0) {
			const name = `s${i}`;
			const len = Math.min(100, COMMAND_CHAR_BUDGET + extra - used - name.length);
			if (len < 1) break;
			subs.push(sub(i, len));
			used += name.length + len;
			i++;
		}
		return { slash: { description: 'A test command', subcommands: subs }, process() {} };
	};
	const exact = build(0);
	const over = build(1);
	const { buildSpec } = require('../helpers/slashRegistry.js');
	assert.strictEqual(commandChars(buildSpec('zztest', exact.slash)), 4000);
	assert.strictEqual(commandChars(buildSpec('zztest', over.slash)), 4001);
	assert.deepStrictEqual(problemsFor(exact).filter(x => /characters/.test(x)), []);
	assert.ok(problemsFor(over).some(x => /4001 characters of names, descriptions and choices \(max 4000\)/.test(x)));
});

test('choice names and values count toward the budget', () => {
	const { buildSpec } = require('../helpers/slashRegistry.js');
	const spec = buildSpec('zz', { description: 'd', options: [{ name: 'o', type: 'INTEGER', description: 'e', choices: [{ name: 'ten', value: 10 }] }] });
	assert.strictEqual(commandChars(spec), 2 + 1 + 1 + 1 + 3 + 2);
});

test('the real command tree passes, /book included and under budget', () => {
	const commands = require('../commands');
	const { problems, specs } = validate(commands);
	assert.deepStrictEqual(problems, []);
	const bookSpec = specs.find(s => s.name === 'book');
	assert.ok(bookSpec, '/book is registered');
	assert.strictEqual(bookSpec.options.length, 18);
	assert.ok(commandChars(bookSpec) < 2000, `/book uses ${commandChars(bookSpec)} of 4000`);
});
