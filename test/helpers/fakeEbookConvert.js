// test/helpers/fakeEbookConvert.js
//
// Stands in for Calibre's ebook-convert: `node fakeEbookConvert.js <input> <output>`. The input
// file is JSON naming what to do, so a test decides the outcome by what its fake Calibre "serves":
//   { mode: 'ok', epub: <path of a synthetic EPUB to copy to output> }
//   { mode: 'drm' }       prints Calibre's DRM error and exits 1
//   { mode: 'corrupt' }   prints a traceback and exits 1
//   { mode: 'empty' }     exits 0 without writing the output
//   { mode: 'hang' }      never ends
//   { mode: 'hang-tree', pidFile }  starts a grandchild that never ends, writes both pids, hangs
// Any mode may add argvFile: the argv it got is written there as JSON, and logFile: a line with
// start and end times is appended, so a test can see two conversions never overlapped.
//
// Not named *.test.js, so `node --test test/*.test.js` does not try to run it.

const fs = require('node:fs');
const cp = require('node:child_process');

const [input, output] = process.argv.slice(2);
let job = {};
try {
	job = JSON.parse(fs.readFileSync(input, 'utf8'));
} catch (_) {
	job = { mode: 'corrupt' };
}
if (job.argvFile) fs.writeFileSync(job.argvFile, JSON.stringify(process.argv.slice(2)));
const started = Date.now();
const done = (code) => {
	if (job.logFile) fs.appendFileSync(job.logFile, `${started} ${Date.now()}\n`);
	process.exit(code);
};

process.stdout.write('Converting input to HTML...\nInputFormatPlugin: MOBI Input running\n');
const hold = () => setInterval(() => {}, 1000);

setTimeout(() => {
	switch (job.mode) {
		case 'ok':
			fs.copyFileSync(job.epub, output);
			process.stdout.write(`EPUB output written to ${output}\n`);
			return done(0);
		case 'drm':
			process.stderr.write('Traceback (most recent call last):\ncalibre.ebooks.DRMError: This book is locked by DRM\n');
			return done(1);
		case 'empty':
			return done(0);
		case 'hang':
			return hold();
		case 'hang-tree': {
			// Detached, as a Calibre worker is: Node otherwise puts its children in a job object
			// that ends them with their parent, and the test would pass without any tree kill.
			const kid = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: true });
			kid.unref();
			fs.writeFileSync(job.pidFile, JSON.stringify({ self: process.pid, kid: kid.pid }));
			return hold();
		}
		default:
			process.stderr.write('Traceback (most recent call last):\nValueError: Not a MOBI file\n');
			return done(1);
	}
}, Number(job.delayMs) || 30);
