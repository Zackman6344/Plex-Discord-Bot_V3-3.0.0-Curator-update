// packages --------------------------------------------------------------------

const { start } = require('./app/utils.js');
const { botToken } = require('./config/keys.js');
const singleInstance = require('./helpers/singleInstance.js');

// Before the login: a second copy must never reach Discord at all.
singleInstance.claim(botToken).then((claimed) => {
	if (claimed) {
		start();
		return;
	}
	process.exitCode = 1;
	// Asking a holder whose event loop is blocked can leave a pipe connect waiting 30 s in
	// Windows, which nothing can cancel and which keeps this process alive. Normally the process
	// has exited well before this fires.
	setTimeout(() => process.exit(1), 1000).unref();
});
