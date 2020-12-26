import _ from "lodash";
import { Vec3 } from "vec3";
import fuzzysort from "fuzzysort";
import sqlite3 from "sqlite3";
import sqlite, { open } from "sqlite";

import * as util from "./util";
import { Bot, Blonbot, BotConfig } from "./blonbot";
import { MineflayerBot } from "./mineflayer";
import escapeStringRegExp from "escape-string-regexp";
import { parseArgsStringToArgv } from "string-argv";

export interface DispatchConfig extends BotConfig {
	db: sqlite.Database;
	commandPrefix: string;
}

// TODO sleep
// botxp
// telegram

export class Dispatch extends Blonbot {
	commandPrefix: string;
	bots: Map<string, Bot>;
	db: sqlite.Database;
	constructor(config: DispatchConfig) {
		const { host, port, username } = config;
		super({ host, port, username });
		this.db = config.db;
		this.commandPrefix = config.commandPrefix;
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

		// parse command
		const prefix = escapeStringRegExp(this.commandPrefix);
		let regex;
		if (parsed.translate === "commands.message.display.incoming") {
			regex = new RegExp(`^(?:${prefix})?(.+)$`);
		} else if (parsed.translate === "chat.type.text") {
			regex = new RegExp(`^${prefix}(.+)$`);
		} else {
			return;
		}
		const match = message.match(regex);
		if (match) {

			const argv = parseArgsStringToArgv(match[1]);
			const reply = (message: string) =>
				this.chat(`/tell ${username} ${message}`);
			try {
				await this.handleCommand(username, argv, reply);
			} catch (e) {
				console.error(e);
				reply(`Does not compute.`);
			}
			return;
		}


		const coordinateMatch = message.match(
			/(-?\d+(?:\.\d+)?)[,\s]\s*(-?\d+(?:\.\d+)?)/
		);
		if (coordinateMatch) {
			const x = parseInt(coordinateMatch[1]);
			const z = parseInt(coordinateMatch[2]);

			const toNether = `${Math.round(x / 8)}, ${Math.round(z / 8)}`;
			const toOverworld = `${x * 8}, ${z * 8}`;

			this.chat(`/me Over→Neth: ${toNether}`);
			this.chat(`/me Neth→Over: ${toOverworld}`);

			return;
		}

	}
	async handleCommand(
		issuer: string,
		argv: string[],
		reply: (message: string) => void
	) {
		const [command, ...args] = argv;
		if (command === "summon") {
			let username, behavior;
			if (args.length === 1) {
				[username] = args;
				behavior = null;
			} else if (args.length === 2) {
				[username, behavior] = args;
			} else {
				reply("Usage: summon <username>");
				return;
			}
			await this.summon(username, behavior, reply);
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
	async summon(username: string, behavior: string | null, reply: (message: string) => void) {
		if (username === this.username) {
			reply(`Can't summon myself!`);
			return;
		}

		let bot;
		if (behavior === null) {
			bot = new Blonbot({
				username,
				host: this.host,
				port: this.port
			});
			bot.setPersist(true);
			bot.start();
			this.bots.set(username, bot);
		} else {
			bot = new MineflayerBot({
				username,
				host: this.host,
				port: this.port,
			});
			bot.setPersist(true);
			console.log("doin behavior");
			bot.pushBehavior(bot.behaviors[behavior]());
			bot.start();
			this.bots.set(username, bot);
		}
		reply(`Summoned ${username}.`);
	}
	async kick(username: string, reply: (message: string) => void) {
		const blonbot = this.bots.get(username);

		if (!blonbot) {
			reply(`Bot "${username}" is not connected.`);
			return;
		}

		blonbot.disconnect();

		this.bots.delete(username);

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

		let blonbot = this.bots.get(teleport.blonbot_username);
		if (!blonbot || !blonbot.connected) {
			blonbot = new Blonbot({
				username: teleport.blonbot_username,
				host: this.host,
				port: this.port
			});
		}
		this.bots.set(teleport.blonbot_username, blonbot);

		const teleportLocation = new Vec3(teleport.x, teleport.y, teleport.z);
		blonbot.interrupt(blonbot.teleport(username, teleport.destination_name, teleportLocation));
		blonbot.start();

		// await util.sleep(1000);

		// blonbot.activateBlock(teleportLocation);

		await util.sleep(1 * 1000); // wait for pearl to land
	}
	async tpls(username: string, reply: (message: string) => void) {
		const teleports = await this.db.all(
			"SELECT * from teleport WHERE username = ?",
			username
		);
		if (!teleports.length) {
			reply(`No teleports set up for ${username}`);
			return;
		}
		const teleportList = teleports
			.map(teleport => teleport.destination_name)
			.join(", ");
		reply(
			`${teleports.length} teleports set up for ${username}: ${teleportList}`
		);
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
		const { changes } = await this.db.run(
			`DELETE FROM teleport WHERE username = ? AND destination_name = ?`,
			username,
			destinationName
		);
		if (!changes) {
			reply(
				`Destination "${destinationName}" not found for player ${username}`
			);
			return;
		}
		reply(`Removed teleport "${destinationName}".`);
	}
}
