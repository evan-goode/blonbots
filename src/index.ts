import sqlite3 from 'sqlite3'
import { open } from 'sqlite'

import { Dispatch } from "./dispatch";

process.on('uncaughtException', function (exception) {
	console.error(exception);
});

(async () => {
    const db = await Dispatch.openDb("./blonbots.db");

	const dispatch = new Dispatch({
		db,
		username: "blon-dispatch",
		host: "localhost",
		port: 25566,
		commandPrefix: "\\",
	});
})();
