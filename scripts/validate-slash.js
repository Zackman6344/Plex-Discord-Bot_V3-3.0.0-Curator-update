#!/usr/bin/env node
// scripts/validate-slash.js
//
// Checks every command's `slash` block against Discord's application-command rules *before* the
// bot tries to register them. This matters more than it looks: registration is all-or-nothing,
// so one malformed spec means zero slash commands appear — every `/x` disappears at once, with
// only a line in the log to explain it.
//
// Run it after adding or editing any `slash` block:
//     npm run check:slash
//
// Exits non-zero if anything would be rejected, so it can gate a commit hook or CI.
// `validate(commands)` is exported so the rules can be tested against hand-made bad specs.

const path = require('path');
const { ApplicationCommandOptionType: T } = require('discord.js');

const ROOT = path.join(__dirname, '..');

const NAME_RE = /^[\w-]{1,32}$/;
// Discord counts name, description and every choice's name and value of a command, options and
// subcommands included, against one 4000-character budget.
const COMMAND_CHAR_BUDGET = 4000;
const CHOICE_TYPES = new Set([T.String, T.Integer, T.Number]);

/**
 * Characters a built spec spends of the per-command budget.
 * @param {object} spec the output of slashRegistry.buildSpec
 */
function commandChars(spec) {
    const count = (node) => {
        let n = String(node.name || '').length + String(node.description || '').length;
        for (const c of node.choices || []) n += String(c.name || '').length + String(c.value === undefined ? '' : c.value).length;
        for (const o of node.options || []) n += count(o);
        return n;
    };
    return count(spec);
}

function checkChoice(where, opt, choice, fail) {
    if (!choice || typeof choice.name !== 'string' || choice.value === undefined) {
        fail(`${where} option "${opt.name}": malformed choice ${JSON.stringify(choice)}`);
        return;
    }
    if (choice.name.length < 1 || choice.name.length > 100) {
        fail(`${where} option "${opt.name}": choice name "${choice.name.slice(0, 40)}" is ${choice.name.length} chars (1-100)`);
    }
    // A value of the wrong type is rejected by Discord, and with it the whole payload.
    const v = choice.value;
    if (opt.type === T.String) {
        if (typeof v !== 'string' || v.length < 1 || v.length > 100) {
            fail(`${where} option "${opt.name}": choice "${choice.name}" needs a string value of 1-100 chars on a STRING option (got ${JSON.stringify(v)})`);
        }
    } else if (opt.type === T.Integer) {
        if (!Number.isInteger(v)) fail(`${where} option "${opt.name}": choice "${choice.name}" needs an integer value on an INTEGER option (got ${JSON.stringify(v)})`);
    } else if (opt.type === T.Number) {
        if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where} option "${opt.name}": choice "${choice.name}" needs a finite number on a NUMBER option (got ${JSON.stringify(v)})`);
    }
}

/**
 * @param {object} commands the plexCommands map (name -> command object, aliases share objects)
 * @param {{ buildSpec?: Function }} [deps]
 * @returns {{ problems: string[], warnings: string[], specs: object[] }}
 */
function validate(commands, deps = {}) {
    const buildSpec = deps.buildSpec || require(path.join(ROOT, 'helpers', 'slashRegistry.js')).buildSpec;
    const problems = [];
    const warnings = [];
    const specs = [];
    const seen = new Set();
    const fail = (msg) => problems.push(msg);

    function checkName(where, name) {
        if (!NAME_RE.test(name || '')) fail(`${where}: invalid name "${name}" (Discord allows ^[\\w-]{1,32}$)`);
        else if (name !== name.toLowerCase()) fail(`${where}: name "${name}" must be lowercase`);
    }

    function checkDescription(where, description) {
        if (!description || !description.length) fail(`${where}: empty description`);
        else if (description.length > 100) fail(`${where}: description is ${description.length} chars (max 100)`);
    }

    function checkOptions(where, options) {
        if (!Array.isArray(options)) return;
        if (options.length > 25) fail(`${where}: ${options.length} options (max 25)`);

        const names = new Set();
        let seenOptional = false;

        for (const opt of options) {
            checkName(`${where} option`, opt.name);
            checkDescription(`${where} option "${opt.name}"`, opt.description);

            if (names.has(opt.name)) fail(`${where}: duplicate option name "${opt.name}"`);
            names.add(opt.name);

            // Discord rejects the whole payload if a required option follows an optional one.
            if (opt.required) {
                if (seenOptional) fail(`${where}: required option "${opt.name}" is declared after an optional one`);
            } else {
                seenOptional = true;
            }

            if (opt.autocomplete && !CHOICE_TYPES.has(opt.type)) {
                fail(`${where} option "${opt.name}": autocomplete only works on STRING, INTEGER and NUMBER options`);
            }

            if (Array.isArray(opt.choices)) {
                if (opt.choices.length > 25) fail(`${where} option "${opt.name}": ${opt.choices.length} choices (max 25)`);
                if (opt.autocomplete) fail(`${where} option "${opt.name}": choices and autocomplete are mutually exclusive`);
                if (!CHOICE_TYPES.has(opt.type)) fail(`${where} option "${opt.name}": choices only work on STRING, INTEGER and NUMBER options`);
                for (const choice of opt.choices) checkChoice(where, opt, choice, fail);
            }
        }
    }

    for (const [name, cmd] of Object.entries(commands)) {
        if (!cmd) { fail(`command "${name}" exported nothing`); continue; }
        if (!cmd.slash) continue;
        if (seen.has(cmd)) continue; // aliases share the command object
        seen.add(cmd);
        if (!NAME_RE.test(name)) continue; // the registry skips these with a warning

        let spec;
        try {
            spec = buildSpec(name, cmd.slash);
        } catch (err) {
            fail(`buildSpec("${name}") threw: ${err.message}`);
            continue;
        }
        specs.push(spec);

        checkName(`/${name}`, spec.name);
        checkDescription(`/${name}`, spec.description);

        const subcommands = (spec.options || []).filter((o) => o.type === T.Subcommand);
        const flat = (spec.options || []).filter((o) => o.type !== T.Subcommand);

        if (subcommands.length && flat.length) fail(`/${name}: mixes subcommands with top-level options`);
        if (subcommands.length > 25) fail(`/${name}: ${subcommands.length} subcommands (max 25)`);

        for (const sub of subcommands) {
            checkName(`/${name} ${sub.name}`, sub.name);
            checkDescription(`/${name} ${sub.name}`, sub.description);
            checkOptions(`/${name} ${sub.name}`, sub.options);
        }
        if (flat.length) checkOptions(`/${name}`, flat);

        const chars = commandChars(spec);
        if (chars > COMMAND_CHAR_BUDGET) fail(`/${name}: ${chars} characters of names, descriptions and choices (max ${COMMAND_CHAR_BUDGET})`);

        // Not a Discord rule, but the bug this catches has shipped twice: a command that refuses to
        // run without an argument, yet offers no field to type one into.
        const source = typeof cmd.process === 'function' ? cmd.process.toString() : '';
        const hasAnyOption = (spec.options || []).length > 0;

        // Only guards on the *initial* argument count. A command that bails out because a follow-up
        // prompt went unanswered (`rawInput = await promptUser(...)`) is interactive by design and
        // needs no option; one whose guarded value comes from `query`/`commandArgs` genuinely cannot
        // be used via slash without a field to type into.
        let needsInput = /\bquery\.length\s*[><]/.test(source);
        for (const guard of source.matchAll(/if\s*\(\s*!\s*([A-Za-z_$][\w$]*)\b/g)) {
            const variable = guard[1];
            const assignment = new RegExp(`(?:const|let|var)\\s+${variable}\\s*=\\s*([^;\\n]+)`).exec(source);
            if (assignment && /\bquery\b|commandArgs/.test(assignment[1])) needsInput = true;
        }
        if (needsInput && !hasAnyOption) {
            warnings.push(`/${name}: the command bails out without an argument but declares no options — slash users have no way to supply one`);
        }
    }

    const duplicates = specs.map((s) => s.name).filter((n, i, all) => all.indexOf(n) !== i);
    for (const name of new Set(duplicates)) fail(`duplicate top-level command name "${name}"`);
    if (specs.length > 100) fail(`${specs.length} commands (Discord's global limit is 100)`);

    return { problems, warnings, specs };
}

function main() {
    const commands = require(path.join(ROOT, 'commands'));
    const { problems, warnings, specs } = validate(commands);
    const payloadBytes = JSON.stringify(specs).length;
    const biggest = specs.map((s) => [s.name, commandChars(s)]).sort((a, b) => b[1] - a[1])[0];

    console.log(`Checked ${specs.length} slash command${specs.length === 1 ? '' : 's'} (${payloadBytes} bytes of registration payload).`);
    if (biggest) console.log(`Largest command: /${biggest[0]} at ${biggest[1]} of ${COMMAND_CHAR_BUDGET} characters.`);

    if (warnings.length) {
        console.log(`\n${warnings.length} warning${warnings.length === 1 ? '' : 's'}:`);
        for (const w of warnings) console.log(`  ! ${w}`);
    }

    if (problems.length) {
        console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} — Discord would reject the whole payload:`);
        for (const p of problems) console.error(`  x ${p}`);
        process.exit(1);
    }

    console.log('\nAll specs valid.');
}

if (require.main === module) main();

module.exports = { validate, commandChars, COMMAND_CHAR_BUDGET };
