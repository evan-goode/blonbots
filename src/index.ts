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
	username: process.env.USERNAME || "blon-dispatch",
	host: process.env.HOST || "localhost",
	port: (process.env.PORT && parseInt(process.env.PORT)) || 25565,
	commandPrefix: "\\",
    });
})();
