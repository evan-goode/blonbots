import { Client } from "minecraft-protocol";
import mineflayer from "mineflayer";
import { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import { performance } from "perf_hooks";

import * as util from "./util";
import { Behavior, Bot, BotConfig } from "./blonbot";

const promisify = (fn: any) => {
	return (...args: any) => {
		return new Promise((resolve, reject) => {
			fn(...args, resolve);
		});
	};
};

export class MineflayerBot extends Bot {
	bot: mineflayer.Bot;
	client: Client;
	username: string;
	host: string;
	port: number;
	ready: Promise<void>;
	persist: boolean;
	connected: boolean;
	startTime: number;
	injectAllowed: Promise<void>;
	constructor(config: BotConfig) {
		super();

		this.dig = this.dig.bind(this);

		this.username = config.username;
		this.host = config.host;
		this.port = config.port;
		this.bot = mineflayer.createBot(config);
		this.startTime = performance.now();

		this.client = this.bot._client;

		this.injectAllowed = promisify(this.bot.once.bind(this.bot))(
			"inject_allowed"
		).then(() => util.sleep(1));
		this.ready = Promise.all([
			this.injectAllowed,
			promisify(this.bot.once.bind(this.bot))("spawn"),
			promisify(this.bot.once.bind(this.bot))("game"),
		]).then(() => {});

		this.client.on("position", ({ x, y, z }) => {
			this.position = new Vec3(x, y, z);
		});

		this.connected = true;
		this.persist = false;

		this.behaviors.dig = this.dig;
	}
	disconnect(reason?: string) {
		this.bot.quit(reason);
		this.connected = false;
	}
	async *dig(): AsyncIterator<any> {
		await this.injectAllowed;
		await this.ready;

		const { yaw, pitch } = this.bot.entity;

		while (true) {
			// @ts-ignore
			const target = this.bot.blockAtCursor(6);
			if (target && this.bot.canDigBlock(target)) {
				yield await this.bot.dig(target);
				yield await this.bot.look(yaw, pitch); // reset look since bot.dig fucks it up
			}
			yield await util.sleep(1 / util.TPS);
		}
	}
}
