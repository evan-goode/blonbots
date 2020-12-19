import _ from "lodash";
import { Vec3 } from "vec3";
import fuzzysort from "fuzzysort";
import sqlite3 from "sqlite3";
import sqlite, { open } from "sqlite";


import * as util from "./util";
import { Blonbot, BlonbotConfig } from "./blonbot";
import escapeStringRegExp from "escape-string-regexp";
import { parseArgsStringToArgv } from "string-argv";

export interface DispatchConfig extends BlonbotConfig {
	db: sqlite.Database;
	commandPrefix: string;
}

// TODO sleep
// tp load/save
// coords conversions

export class Dispatch extends Blonbot {
	commandPrefix: string;
	escapedCommandPrefix: string;
	bots: Map<string, Blonbot>;
	db: sqlite.Database;
	constructor(config: DispatchConfig) {
		const { host, port, username } = config;
		super({ host, port, username });
		this.db = config.db;
		this.commandPrefix = config.commandPrefix;
		this.escapedCommandPrefix = escapeStringRegExp(this.commandPrefix);
		this.client.on("chat", this.onChat.bind(this));
		this.bots = new Map();
	}
	static async openDb(path: string) {
		const db = await open({
			filename: path,
			driver: sqlite3.Database
		});
		await db.exec(`
			CREATE TABLE IF NOT EXISTS teleport(
				destination_name TEXT NOT NULL,
				username TEXT NOT NULL,
				x INTEGER NOT NULL,
				y INTEGER NOT NULL,
				z INTEGER NOT NULL,
				blonbot_username TEXT NOT NULL,
				UNIQUE (destination_name, username)
			);
		`);
		return db;
	}
	async onChat(packet: any) {
		const parsed = JSON.parse(packet.message);
		const validTranslates = [
			"commands.message.display.incoming",
			"chat.type.text"
		];
		if (!_.includes(validTranslates, parsed.translate)) return;

		const username = parsed.with[0].text;
		if (username === this.username) return;

		const message = parsed.with[1].text || parsed.with[1];

		const match = message.match(
			new RegExp(`^${escapeStringRegExp(this.commandPrefix)}(.+)$`)
		);
		if (!match) return;

		const argv = parseArgsStringToArgv(match[1]);
		const reply = (message: string) => {
			this.client.write("chat", {
				message: `/tell ${username} ${message}`
			});
		};
		try {
			await this.handleCommand(username, argv, reply);
		} catch (e) {
			console.error(e);
			reply(`Does not compute.`);
		}
	}
	async handleCommand(
		issuer: string,
		argv: string[],
		reply: (message: string) => void
	) {
		reply("your command was:");
		reply(argv.join(" "));
		const [command, ...args] = argv;
		if (command === "summon") {
			if (args.length !== 1) {
				reply("Usage: summon <username>");
				return;
			}
			const [username] = args;
			await this.summon(username, reply);
		} else if (command === "kick") {
			if (args.length !== 1) {
				reply("Usage: kick <username>");
				return;
			}
			const [username] = args;
			await this.kick(username, reply);
		} else if (command === "tp") {
			if (args.length === 1) {
				const [fuzzyDestination] = args;
				await this.tp(issuer, fuzzyDestination, reply);
			} else if (args.length === 2) {
				const [username, fuzzyDestination] = args;
				await this.tp(username, fuzzyDestination, reply);
			} else {
				reply("Usage: tp [username] <destination>");
				return;
			}
		} else if (command === "tpset") {
			let destinationName, x, y, z, blonbotUsername, username;
			if (args.length === 5) {
				[destinationName, x, y, z, blonbotUsername] = args;
				username = issuer;
			} else if (args.length === 6) {
				[destinationName, x, y, z, blonbotUsername, username] = args;
			} else {
				reply(
					"Usage: tpset <destination-name> <x> <y> <z> <bot-username> [player]"
				);
				return;
			}
			const xCoord = Math.floor(parseFloat(x));
			const yCoord = Math.floor(parseFloat(y));
			const zCoord = Math.floor(parseFloat(z));
			const location = new Vec3(xCoord, yCoord, zCoord);
			await this.tpset(
				issuer,
				destinationName,
				location,
				blonbotUsername,
				reply
			);
		} else if (command === "tpls") {
			let username;
			if (args.length === 0) {
				username = issuer;
			} else if (args.length === 1) {
				[username] = args;
			} else {
				reply(`Usage: tpls [username]`);
				return;
			}
			await this.tpls(username, reply);
		} else if (command === "tprm") {
			let username, destination;
			if (args.length === 1) {
				[destination] = args;
				username = issuer;
			} else if (args.length === 2) {
				[destination, username] = args;
			} else {
				reply(`Usage: tpls [username]`);
				return;
			}
			await this.tprm(username, destination, reply);
		} else {
			reply(`Command "${command}" not found.`);
		}
	}
	async summon(username: string, reply: (message: string) => void) {
		if (username === this.username) {
			reply(`Can't summon myself!`);
			return;
		}

		const blonbot = new Blonbot({
			username,
			host: this.host,
			port: this.port
		});
		this.bots.set(username, blonbot);
		await blonbot.recv("position");
		reply(`Summoned ${username}.`);
	}
	async kick(username: string, reply: (message: string) => void) {
		const blonbot = this.bots.get(username);
		
		if (!blonbot) {
			reply(`Bot "${username}" is not connected.`);
			return;
		}

		this.bots.delete(username);

		blonbot.client.end("");
	}
	async tp(
		username: string,
		fuzzyDestination: string,
		reply: (message: string) => void
	) {
		const teleports = await this.db.all(
			"SELECT * from teleport WHERE username = ?",
			username
		);
		const matches = fuzzysort.go(fuzzyDestination, teleports, {
			key: "destination_name"
		});
		if (!matches.length) {
			reply(
				`No teleport found matching "${fuzzyDestination}" for player "${username}"`
			);
			return;
		}
		const teleport = matches[0].obj;

		const blonbot = new Blonbot({
			username: teleport.blonbot_username,
			host: this.host,
			port: this.port
		});
		this.bots.set(teleport.blonbot_username, blonbot);

		const teleportLocation = new Vec3(teleport.x, teleport.y, teleport.z);
		const {x, y, z} = (await blonbot.recv("position") as any);

		const dist = new Vec3(x, y, z).distanceTo(teleportLocation);
		const reach = 5;
		if (dist > reach) {
			reply(`Warning: ${teleport.blonbot_username} is ${dist.toFixed(1)} blocks away from the trigger. Teleport may fail.`);
		}

		blonbot.activateBlock(teleportLocation);

		try {
			await blonbot.waitForBlockChange(teleportLocation, 1000);
		} catch (e) {
			if (e instanceof util.TimeoutError) {
				reply(`Error: teleport timed out.`);
				return;
			}
			throw e;
		}

		reply(`Initiated teleport to ${teleport.destination_name}.`);

		await util.sleep(1 * 1000); // wait for pearl to land
		blonbot.client.end("");
	}
	async tpls(
		username: string,
		reply: (message: string) => void
	) {
		const teleports = await this.db.all(
			"SELECT * from teleport WHERE username = ?",
			username
		);
		if (!teleports.length) {
			reply(`No teleports set up for ${username}`);
			return;
		}
		const teleportList = teleports.map(teleport => teleport.destination_name).join(", ");
		reply(`${teleports.length} teleports set up for ${username}: ${teleportList}`);
	}
	async tpset(
		username: string,
		destinationName: string,
		location: Vec3,
		blonbotUsername: string,
		reply: (message: string) => void
	) {
		await this.db.run(
			`INSERT OR REPLACE INTO teleport(username, destination_name, x, y, z, blonbot_username) values (
				:username,
				:destination_name,
				:x,
				:y,
				:z,
				:blonbot_username
			)
		`,
			{
				":username": username,
				":destination_name": destinationName,
				":x": location.x,
				":y": location.y,
				":z": location.z,
				":blonbot_username": blonbotUsername
			}
		);
		reply(`Updated teleport "${destinationName}".`);
	}
	async tprm(
		username: string,
		destinationName: string,
		reply: (message: string) => void
	) {
		const {changes} = await this.db.run(`DELETE FROM teleport WHERE username = ? AND destination_name = ?`, username, destinationName);
		if (!changes) {
			reply(`Destination "${destinationName}" not found for player ${username}`);
			return;
		}
		reply(`Removed teleport "${destinationName}".`);
	}
}
