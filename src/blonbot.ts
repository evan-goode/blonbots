import mc, { Client } from "minecraft-protocol";
import { Vec3 } from "vec3";
import { EventEmitter } from "events";

import * as util from "./util";

export interface BotConfig {
	host: string;
	port: number;
	username: string;
}

class AwaitableEventEmitter extends EventEmitter {
	constructor() {
		super();
	}
	wait(type: string) {
		return new Promise<string>(r => {
			this.once(type, r);
		});
	}
}

export type Behavior = AsyncIterator<any>;

export abstract class Bot {
	abstract username: string;
	abstract host: string;
	abstract port: number;
	abstract connected: boolean;
	abstract persist: boolean;
	abstract disconnect(): void;
	abstract client: Client;
	started: boolean;
	position: Vec3 | null;
	behaviors: Record<string, (...args: any[]) => Behavior>;
	eventEmitter: AwaitableEventEmitter;
	behaviorQueue: Behavior[];
	constructor() {
		this.behaviorQueue = [];
		this.eventEmitter = new AwaitableEventEmitter();
		this.behaviors = {};
		this.behaviors.teleport = this.teleport;
		this.started = false;
		this.position = null;
	}
	recv(packetName: string) {
		return new Promise(r => {
			this.client.once(packetName, r);
		});
	}
	chat(message: string) {
		this.client.write("chat", {message});
	}
	async start() {
		if (this.started) return;
		this.started = true;
		while (this.connected && (this.persist || this.behaviorQueue.length)) {
			if (this.behaviorQueue.length) {
				const currentBehavior = this.behaviorQueue[0];
				const next = currentBehavior.next();
				const result = await Promise.race([
					next,
					this.eventEmitter.wait("interrupt")
				]);
				if (!(await util.isPending(next)) && (await next).done) {
					this.behaviorQueue.shift();
				}
			} else {
				await Promise.race([
					this.eventEmitter.wait("interrupt"),
					this.eventEmitter.wait("pushBehavior"),
					this.eventEmitter.wait("persist")
				]);
			}
		}
		this.disconnect();
	}
	setPersist(persist: boolean) {
		this.persist = persist;
		this.eventEmitter.emit("persist", persist);
	}
	interrupt(behavior: Behavior) {
		this.behaviorQueue.unshift(behavior);
		this.eventEmitter.emit("interrupt", behavior);
	}
	pushBehavior(behavior: Behavior) {
		this.behaviorQueue.push(behavior);
		this.eventEmitter.emit("pushBehavior", behavior);
	}
	async *teleport(username: string, destinationName: string, location: Vec3): AsyncIterator<void> {
		let position = this.position;
		if (!position) {
			const { x, y, z } = (await this.recv("position") as any);
			position = new Vec3(x, y, z);
		}

		const reply = (message: string) => this.chat(`/tell ${username} ${message}`);

		const dist = position.distanceTo(location);
		const reach = 5; // not sure what this should be. probably a different between Notchian clients and what the server actually checks.
		if (dist > reach) {
			reply(
				`Warning: I am ${dist.toFixed(1)} blocks away from the trigger. Teleport may fail.`
			);
		}

		this.client.write("block_place", {
			location,
			direction: 1,
			hand: 0,
			cursorX: 0.5,
			cursorY: 0.5,
			cursorZ: 0.5,
			insideBlock: false
		});

		if (this.username.toLowerCase().includes("mom")) {
			reply(`Have a nice trip, honey!`);
		} else {
			reply(`Initiated teleport to ${destinationName}.`);
		}

		yield await util.sleep(1000); // wait for pearl to land
	}
}

export class Blonbot extends Bot {
	client: Client;
	username: string;
	host: string;
	port: number;
	connected: boolean;
	persist: boolean;
	behaviors: Record<string, (...args: any[]) => Behavior>;
	constructor(config: BotConfig) {
		super();
		this.client = mc.createClient(config);
		this.connected = true;
		this.username = config.username;
		this.host = config.host;
		this.port = config.port;
		this.persist = false;
		this.behaviors = {};
		// TODO tweak viewDistance for best perf
		// this.client.write("settings", {
		// 	locale: "en_us",
		// 	viewDistance: 2,
		// 	chatFlags: 0,
		// 	chatColors: true,
		// 	skinParts: 127,
		// 	mainHand: 1
		// });

		this.client.on("position", ({ x, y, z, teleportId }) => {
			this.position = new Vec3(x, y, z);
			this.client.write("teleport_confirm", { teleportId });
		});
	}

	disconnect(reason?: string) {
		this.client.end(reason || "");
		this.connected = false;
	}
}

